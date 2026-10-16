import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db/prisma";
import { revalidatePrivateOwnerSession, resolvePrivateOwnerBinding, type PrivateOwnerSessionBinding, type AuthSession } from "@/lib/security/auth";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import { getActiveProjectRoot } from "@/lib/workspace/shell";

export type ExecutionOperation = "read" | "write" | "command" | "model" | "memory" | "manage";
const OPERATIONS: readonly ExecutionOperation[] = ["read", "write", "command", "model", "memory", "manage"];
const MINT_EXECUTION = Symbol("mint-execution");

export type ExecutionWorkspace = Readonly<{
  id: string | null;
  runtimeType: "local" | "cloud";
  provider: string | null;
  providerWorkspaceId: string | null;
  repositoryUrl: string | null;
  branch: string | null;
}>;

/** Private fields retain provenance, not an authorization cache. */
class ExecutionCapability {
  readonly ownerId = "owner" as const;
  /** Correlation only; never session identity or proof of authorization. */
  readonly executionId = randomUUID();
  readonly projectId: string;
  readonly workspace: ExecutionWorkspace;
  readonly permissions: readonly ExecutionOperation[];
  readonly signal: AbortSignal;
  #session: AuthSession;
  #controller: AbortController;

  constructor(key: symbol, session: AuthSession, projectId: string, workspace: ExecutionWorkspace,
    permissions: readonly ExecutionOperation[], signal?: AbortSignal) {
    if (key !== MINT_EXECUTION) throw new ExecutionAuthorizationError(401);
    this.#session = session;
    this.#controller = new AbortController();
    this.projectId = projectId;
    this.workspace = workspace;
    this.permissions = Object.freeze([...permissions]);
    this.signal = signal ? AbortSignal.any([this.#controller.signal, signal]) : this.#controller.signal;
    Object.freeze(this);
  }

  static async validate(context: ExecutionAuthorizationContext | undefined, projectId: string,
    operation: ExecutionOperation): Promise<void> {
    if (!context || typeof context !== "object" || !(#session in context)) throw new ExecutionAuthorizationError(401);
    try {
      if (context.signal.aborted) throw new ExecutionAuthorizationError(401);
      if (context.projectId !== projectId || !context.permissions.includes(operation)) throw new ExecutionAuthorizationError(403);
      if (!await revalidatePrivateOwnerSession(context.#session)) throw new ExecutionAuthorizationError(401);
      const workspace = await registeredWorkspace(projectId);
      if (JSON.stringify(workspace) !== JSON.stringify(context.workspace)) throw new ExecutionAuthorizationError(409);
      if (context.signal.aborted) throw new ExecutionAuthorizationError(401);
    } catch (error) {
      context.#controller.abort();
      if (error instanceof ExecutionAuthorizationError) throw error;
      throw new ExecutionAuthorizationError(503);
    }
  }

  static async approvalBinding(context: ExecutionAuthorizationContext, operation: ExecutionOperation): Promise<PrivateOwnerSessionBinding> {
    // Validate provenance before reading any purported scope or private field.
    if (!context || typeof context !== "object" || !(#session in context)) throw new ExecutionAuthorizationError(401);
    await ExecutionCapability.validate(context, context.projectId, operation);
    try {
      const binding = await resolvePrivateOwnerBinding(context.#session);
      if (!binding || context.signal.aborted) throw new ExecutionAuthorizationError(401);
      return binding;
    } catch (error) {
      context.#controller.abort();
      if (error instanceof ExecutionAuthorizationError) throw error;
      throw new ExecutionAuthorizationError(503);
    }
  }

  static cancel(context: ExecutionAuthorizationContext | undefined): void {
    if (context && typeof context === "object" && #controller in context) context.#controller.abort();
  }
}

/** Opaque server capability: private fields survive neither JSON nor property copies. */
export type ExecutionAuthorizationContext = ExecutionCapability;

export class ExecutionAuthorizationError extends Error {
  constructor(readonly status: 401 | 403 | 404 | 409 | 503, message?: string) {
    super(message ?? {
      401: "Authentication required.",
      403: "Execution is not authorized.",
      404: "Registered project not found.",
      409: "The workspace authorization has changed.",
      503: "Execution authorization is unavailable.",
    }[status]);
    this.name = "ExecutionAuthorizationError";
  }
}

async function assertUniqueLocalRoot(projectId: string): Promise<void> {
  if (projectId.startsWith("/") || /^[A-Za-z]:/.test(projectId) ||
      projectId.replace(/\\/g, "/").split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ExecutionAuthorizationError(409);
  }
  let root: string;
  try { root = getActiveProjectRoot(projectId); } catch { throw new ExecutionAuthorizationError(409); }
  const projects = await prisma.project.findMany({
    where: { OR: [{ workspaces: { none: {} } }, { workspaces: { some: { runtimeType: "local" } } }] },
    select: { id: true },
  });
  for (const project of projects) {
    if (project.id === projectId) continue;
    try {
      if (getActiveProjectRoot(project.id) === root) throw new ExecutionAuthorizationError(409);
    } catch (error) {
      if (error instanceof ExecutionAuthorizationError) throw error;
      // Other malformed registrations cannot authorize this project or its path.
    }
  }
}

async function registeredWorkspace(projectId: string): Promise<ExecutionWorkspace> {
  if (typeof projectId !== "string" || !projectId || projectId.length > 256 || projectId.includes("\0")) {
    throw new ExecutionAuthorizationError(404);
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaces: { select: {
      id: true, projectId: true, runtimeType: true, provider: true,
      providerWorkspaceId: true, repositoryUrl: true, branch: true,
    } } },
  });
  if (!project || project.id !== projectId) throw new ExecutionAuthorizationError(404);
  const workspace = project.workspaces[0];
  if (project.workspaces.length > 1 || (workspace && workspace.projectId !== projectId)) {
    throw new ExecutionAuthorizationError(409);
  }
  if (!workspace) {
    // Existing registered local projects predate Workspace records. Do not
    // rewrite their IDs or silently turn an unmapped cloud project into local.
    if (process.env.VERCEL_ENV || process.env.CR8OR_WORKSPACE_MODE === "cloud" || projectId.startsWith("cloud-")) {
      throw new ExecutionAuthorizationError(409);
    }
    await assertUniqueLocalRoot(projectId);
    return Object.freeze({ id: null, runtimeType: "local", provider: null,
      providerWorkspaceId: null, repositoryUrl: null, branch: null });
  }
  if (workspace.runtimeType !== "local" && workspace.runtimeType !== "cloud") throw new ExecutionAuthorizationError(409);
  if (workspace.runtimeType === "cloud") {
    if (workspace.provider !== "daytona" || !workspace.providerWorkspaceId) throw new ExecutionAuthorizationError(409);
    // A provider runtime must not be selectable through another project record.
    const associations = await prisma.workspace.count({ where: {
      provider: workspace.provider, providerWorkspaceId: workspace.providerWorkspaceId,
    } });
    if (associations !== 1) throw new ExecutionAuthorizationError(409);
  } else if (workspace.provider || workspace.providerWorkspaceId || process.env.VERCEL_ENV ||
      process.env.CR8OR_WORKSPACE_MODE === "cloud") {
    throw new ExecutionAuthorizationError(409);
  }
  if (workspace.runtimeType === "local") await assertUniqueLocalRoot(projectId);
  return Object.freeze({ id: workspace.id, runtimeType: workspace.runtimeType,
    provider: workspace.provider, providerWorkspaceId: workspace.providerWorkspaceId,
    repositoryUrl: workspace.repositoryUrl, branch: workspace.branch });
}

/** Call only with the AuthSession returned by authorizeRoute, never request JSON. */
export async function createExecutionAuthorization(
  session: AuthSession,
  projectId: string,
  options: { permissions?: readonly ExecutionOperation[]; signal?: AbortSignal } = {},
): Promise<ExecutionAuthorizationContext | undefined> {
  if (!session || typeof session !== "object") throw new ExecutionAuthorizationError(401);
  if (getPrivateAuthMode() === "inactive" && session.provider !== "private-session") return undefined;
  try {
    if (!await revalidatePrivateOwnerSession(session)) throw new ExecutionAuthorizationError(401);
    const workspace = await registeredWorkspace(projectId);
    const permissions = [...new Set(options.permissions ?? OPERATIONS)];
    if (permissions.some((permission) => !OPERATIONS.includes(permission))) throw new ExecutionAuthorizationError(403);
    const context = new ExecutionCapability(MINT_EXECUTION, session, projectId, workspace, permissions, options.signal);
    // Registry lookup can wait on infrastructure; validate again before handing
    // the capability to execution. A request already cancelled cannot start work.
    await revalidateExecutionAuthorization(context, projectId, permissions[0] ?? "read");
    return context;
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) throw error;
    throw new ExecutionAuthorizationError(503);
  }
}

/** Every sensitive boundary queries the session and current registry afresh. */
export async function revalidateExecutionAuthorization(
  context: ExecutionAuthorizationContext | undefined,
  projectId: string,
  operation: ExecutionOperation,
): Promise<void> {
  if (!context && getPrivateAuthMode() === "inactive") return;
  await ExecutionCapability.validate(context, projectId, operation);
}

/** Disconnects and failed authorization stop queued work sharing this context. */
export function cancelExecutionAuthorization(context: ExecutionAuthorizationContext | undefined): void {
  ExecutionCapability.cancel(context);
}

/** Internal approval persistence uses the initiating session, never a model or
 * client's session identifier. Do not serialize this binding into a tool DTO. */
export async function resolveExecutionSessionBinding(context: ExecutionAuthorizationContext, operation: ExecutionOperation = "command"): Promise<PrivateOwnerSessionBinding> {
  return ExecutionCapability.approvalBinding(context, operation);
}
