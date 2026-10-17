import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { canonicalGitRepository, validGitRef } from "@/lib/security/git-operation-catalogue";

const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const name = z.string().min(1).max(120).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
const branch = z.string().refine(validGitRef);
const repository = z.string().max(256).refine(value => {
  try { return value.startsWith("https://github.com/") && !!canonicalGitRepository(value); } catch { return false; }
});
const common = { idempotencyKey: z.string().uuid() };
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), ...common, projectName: name }).strict(),
  z.object({ action: z.literal("clone"), ...common, repositoryUrl: repository, branch, projectName: name.optional() }).strict(),
  z.object({ action: z.literal("start"), ...common, projectId: identifier }).strict(),
  z.object({ action: z.literal("stop"), ...common, projectId: identifier }).strict(),
]);
export type WorkspaceLifecycleRequest = Readonly<z.infer<typeof requestSchema>>;
export function parseWorkspaceLifecycleRequest(input: unknown): WorkspaceLifecycleRequest {
  const result = requestSchema.safeParse(input);
  if (!result.success) throw new ExecutionAuthorizationError(403, "Workspace lifecycle request is invalid.");
  return Object.freeze(result.data);
}

const scopeSchema = z.object({
  version: z.literal(1), ownerId: z.literal("owner"), action: z.enum(["create", "clone", "start", "stop"]),
  projectId: identifier, workspaceRecordId: identifier, providerWorkspaceId: identifier.nullable(),
  projectName: name, repositoryKey: z.string().min(3).max(140).nullable(),
  repositoryUrl: repository.nullable(), branch: branch.nullable(),
}).strict();
export type WorkspaceLifecycleScope = Readonly<z.infer<typeof scopeSchema>>;
export function validateWorkspaceLifecycleScope(input: unknown): WorkspaceLifecycleScope {
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) throw new ExecutionAuthorizationError(403, "Workspace lifecycle scope is invalid.");
  const scope = parsed.data;
  if (scope.repositoryUrl) {
    const canonical = canonicalGitRepository(scope.repositoryUrl);
    if (scope.repositoryKey !== canonical.key || scope.repositoryUrl !== canonical.url || !scope.branch) {
      throw new ExecutionAuthorizationError(403, "Workspace lifecycle scope is invalid.");
    }
  } else if (scope.repositoryKey !== null || scope.branch !== null) {
    throw new ExecutionAuthorizationError(403, "Workspace lifecycle scope is invalid.");
  }
  if ((scope.action === "create" && (scope.repositoryUrl !== null || scope.providerWorkspaceId !== null)) ||
      (scope.action === "clone" && (!scope.repositoryUrl || scope.providerWorkspaceId !== null)) ||
      (["start", "stop"].includes(scope.action) && !scope.providerWorkspaceId)) {
    throw new ExecutionAuthorizationError(403, "Workspace lifecycle scope is invalid.");
  }
  return Object.freeze(scope);
}

export function workspaceLifecycleScopeDigest(input: WorkspaceLifecycleScope): string {
  const scope = validateWorkspaceLifecycleScope(input);
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(scope).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
}

/** Correlation keys are not ownership claims. A new identity is derived on the
 * server from the verified initiating session and its idempotency key. No
 * client-supplied project or provider ID is accepted for provisioning. */
export function reservedLifecycleIdentity(sessionId: string, idempotencyKey: string) {
  const digest = createHash("sha256").update(`cr8or-lifecycle/1\n${sessionId}\n${idempotencyKey}`).digest("hex");
  return { projectId: `cloud-${digest.slice(0, 32)}`, workspaceRecordId: `workspace-${digest.slice(32)}` };
}
