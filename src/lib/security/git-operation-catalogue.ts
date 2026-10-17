import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { ExecutionAuthorizationError, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { resolveGitProjectCode } from "@/lib/security/git-project-naming";

export const GIT_MAX_CONTENT_BYTES = 256 * 1024;
export const GIT_OPERATION_KEYS = ["status", "branch", "changes", "diff", "log", "remote", "stage", "unstage", "commit", "push", "create-branch", "create-pr", "upsert-file", "list-branches", "list-contents", "read-file", "pr-checks"] as const;
export type GitOperationKey = typeof GIT_OPERATION_KEYS[number];
const MUTATIONS = new Set<GitOperationKey>(["stage", "unstage", "commit", "push", "create-branch", "create-pr", "upsert-file"]);
export function isGitMutation(key: string): boolean { return MUTATIONS.has(key as GitOperationKey); }
export function isGithubOperation(key: string): boolean {
  return ["push", "create-branch", "create-pr", "upsert-file", "list-branches", "list-contents", "read-file", "pr-checks"].includes(key);
}

export function validGitRef(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") && !value.includes("//") && !value.endsWith(".") &&
    value.split("/").every((part) => !!part && !part.startsWith(".") && !part.endsWith(".lock")) &&
    !value.startsWith("refs/") && value !== "HEAD";
}
export function validGitPath(value: string): boolean {
  if (!value || Buffer.byteLength(value, "utf8") > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value || /[\x00-\x1f\x7f\\:*?\[\]]/.test(value) || value.startsWith("-")) return false;
  return value.split("/").every((part) => !!part && part !== "." && part !== ".." &&
    !part.startsWith(".git") && !/^\.env(?:\.|$)/i.test(part) &&
    !/^(?:\.ssh|\.aws|\.npmrc|\.netrc|credentials|id_rsa|id_ed25519)$/i.test(part));
}
const ref = z.string().refine(validGitRef);
const path = z.string().refine(validGitPath);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const category = z.enum(["General maintenance", "Code improvements", "Documentation updates", "Test improvements", "Configuration updates"]);
const common = { branch: ref.optional() };
const paths = z.array(path).min(1).max(64).refine((items) => new Set(items).size === items.length && items.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8"), 0) <= 16 * 1024);
const localMutation = { ...common, branch: ref, expectedHead: sha, expectedIndex: digest };
const remoteMutation = { ...common, branch: ref, expectedRemoteHead: sha };
const schema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status"), ...common }).strict(),
  ...(["branch", "changes", "log", "remote", "list-branches"] as const).map((operation) => z.object({ operation: z.literal(operation), ...common }).strict()),
  z.object({ operation: z.literal("diff"), ...common, paths, staged: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("stage"), ...localMutation, paths }).strict(),
  z.object({ operation: z.literal("unstage"), ...localMutation, paths }).strict(),
  z.object({ operation: z.literal("commit"), ...localMutation, category }).strict(),
  z.object({ operation: z.literal("push"), ...remoteMutation, targetCommit: sha }).strict(),
  z.object({ operation: z.literal("create-branch"), ...remoteMutation, targetBranch: ref, targetCommit: sha }).strict(),
  z.object({ operation: z.literal("create-pr"), ...remoteMutation, baseBranch: ref, expectedBase: sha, category }).strict(),
  z.object({ operation: z.literal("upsert-file"), ...remoteMutation, filePath: path, expectedBlob: sha.nullable(), content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= GIT_MAX_CONTENT_BYTES && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)), category }).strict(),
  z.object({ operation: z.literal("list-contents"), ...common, filePath: path.optional() }).strict(),
  z.object({ operation: z.literal("read-file"), ...common, filePath: path }).strict(),
  z.object({ operation: z.literal("pr-checks"), ...common, pullNumber: z.number().int().positive().max(2_147_483_647) }).strict(),
]);
export type GitOperationRequest = z.infer<typeof schema>;

export function parseGitOperation(value: unknown): GitOperationRequest {
  const result = schema.safeParse(value);
  if (!result.success) throw new ExecutionAuthorizationError(403, "Git operation is not permitted.");
  if ("paths" in result.data) Object.freeze(result.data.paths);
  return Object.freeze(result.data);
}

/** Credential-bearing URLs, alternate hosts, ports, query strings and fragments
 * are never repository identities. No URL supplied by a browser is fetched. */
export function canonicalGitRepository(value: string): { key: string; owner: string; repo: string; url: string } {
  const match = typeof value === "string" && /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/.exec(value);
  if (!match || [".", ".."].includes(match[2])) throw new ExecutionAuthorizationError(409, "Registered repository is not supported.");
  const owner = match[1].toLowerCase(), repo = match[2].toLowerCase();
  return Object.freeze({ key: `${owner}/${repo}`, owner, repo, url: `https://github.com/${owner}/${repo}.git` });
}
const scopeSchema = z.object({
  ownerId: z.literal("owner"), projectId: z.string().min(1).max(256), workspaceRecordId: z.string().min(1).max(256),
  providerWorkspaceId: z.string().min(1).max(256), repositoryKey: z.string().min(3).max(140),
  operationKey: z.enum(GIT_OPERATION_KEYS), branch: ref, paths: z.array(path).max(64),
  expectedHead: sha.nullable(), expectedIndex: digest.nullable(), expectedRemoteHead: sha.nullable(),
  targetCommit: sha.nullable(), targetBranch: ref.nullable(), baseBranch: ref.nullable(),
  filePath: path.nullable(), expectedBlob: sha.nullable(), expectedBase: sha.nullable(), category: category.nullable(), contentDigest: digest.nullable(), payloadDigest: digest,
  pullRequestNaming: z.object({ version: z.literal(1), projectCode: z.string().regex(/^[A-Z][A-Z0-9]{1,19}$/),
    strategy: z.literal("approved-head-successor") }).strict().optional(),
}).strict();
export type GitOperationScope = Readonly<z.infer<typeof scopeSchema>>;
export function validateGitOperationScope(value: unknown): GitOperationScope {
  const result = scopeSchema.safeParse(value);
  if (!result.success || Buffer.byteLength(JSON.stringify(result.data), "utf8") > 24 * 1024 || canonicalGitRepository(`https://github.com/${result.data.repositoryKey}`).key !== result.data.repositoryKey) {
    throw new ExecutionAuthorizationError(403, "Git approval scope is invalid.");
  }
  if (result.data.operationKey === "create-pr") {
    let projectCode: string;
    try { projectCode = resolveGitProjectCode(result.data.repositoryKey); }
    catch { throw new ExecutionAuthorizationError(403, "Git approval scope is invalid."); }
    if (!result.data.pullRequestNaming || result.data.pullRequestNaming.projectCode !== projectCode ||
        !result.data.expectedRemoteHead || !result.data.expectedBase || !result.data.baseBranch || !result.data.category) {
      throw new ExecutionAuthorizationError(403, "Git approval scope is invalid.");
    }
    Object.freeze(result.data.pullRequestNaming);
  } else if (result.data.pullRequestNaming !== undefined) {
    throw new ExecutionAuthorizationError(403, "Git approval scope is invalid.");
  }
  Object.freeze(result.data.paths);
  return Object.freeze(result.data);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function gitScopeDigest(scope: GitOperationScope): string { return createHash("sha256").update(stable(validateGitOperationScope(scope))).digest("hex"); }

/** Authentication/provenance must be checked by the service before this pure
 * derivation. The result alone is never a capability. */
export function buildGitOperationScope(context: Pick<ExecutionAuthorizationContext, "projectId" | "workspace">, input: GitOperationRequest): GitOperationScope {
  const request = parseGitOperation(input);
  const workspace = context.workspace;
  if (!workspace.id || workspace.runtimeType !== "cloud" || workspace.provider !== "daytona" || !workspace.providerWorkspaceId ||
      !workspace.repositoryUrl || !workspace.branch || !validGitRef(workspace.branch)) throw new ExecutionAuthorizationError(409, "Git requires a registered repository and Daytona workspace.");
  if (request.branch && request.branch !== workspace.branch) throw new ExecutionAuthorizationError(403, "Git branch is outside the authorized scope.");
  const get = (key: string): string | null => typeof (request as Record<string, unknown>)[key] === "string" ? (request as Record<string, string>)[key] : null;
  const repository = canonicalGitRepository(workspace.repositoryUrl);
  const canonicalRequest = { ...request, branch: workspace.branch };
  let pullRequestNaming: GitOperationScope["pullRequestNaming"];
  if (request.operation === "create-pr") {
    let projectCode: string;
    try { projectCode = resolveGitProjectCode(repository.key); }
    catch { throw new ExecutionAuthorizationError(409, "Registered project naming is unavailable."); }
    pullRequestNaming = { version: 1, projectCode, strategy: "approved-head-successor" };
  }
  return validateGitOperationScope({ ownerId: "owner", projectId: context.projectId,
    workspaceRecordId: workspace.id, providerWorkspaceId: workspace.providerWorkspaceId, repositoryKey: repository.key,
    operationKey: request.operation, branch: workspace.branch, paths: "paths" in request ? [...request.paths].sort() : [],
    expectedHead: get("expectedHead"), expectedIndex: get("expectedIndex"), expectedRemoteHead: get("expectedRemoteHead"),
    targetCommit: get("targetCommit"), targetBranch: get("targetBranch"), baseBranch: get("baseBranch"), filePath: get("filePath"), expectedBlob: get("expectedBlob"),
    expectedBase: get("expectedBase"), category: get("category"),
    ...(pullRequestNaming ? { pullRequestNaming } : {}),
    contentDigest: "content" in request ? createHash("sha256").update(request.content, "utf8").digest("hex") : null,
    payloadDigest: createHash("sha256").update(stable(canonicalRequest)).digest("hex") });
}
