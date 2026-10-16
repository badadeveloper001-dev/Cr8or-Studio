import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { resolvePrivateOwnerBinding, type AuthSession } from "@/lib/security/auth";
import {
  canonicalGitRepository, gitScopeDigest, isGitMutation, validateGitOperationScope,
  type GitOperationScope,
} from "@/lib/security/git-operation-catalogue";
import {
  ExecutionAuthorizationError,
  resolveExecutionSessionBinding,
  type ExecutionAuthorizationContext,
} from "@/lib/security/execution-context";

export const PRIVATE_GIT_APPROVAL_TTL_MS = 10 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSACTION_OPTIONS = { isolationLevel: "ReadCommitted" as const, maxWait: 5_000, timeout: 5_000 };
type Binding = NonNullable<Awaited<ReturnType<typeof resolvePrivateOwnerBinding>>>;
type Tx = Prisma.TransactionClient;
type ApprovalState = "PENDING" | "APPROVED" | "DENIED" | "REVOKED";
type ApprovalRow = {
  id: string; ownerId: string; sessionId: string; credentialVersion: number;
  projectId: string; workspaceRecordId: string; providerWorkspaceId: string; repositoryKey: string; operationKey: string; scope: GitOperationScope; scopeDigest: string;
  status: ApprovalState; createdAt: Date; expiresAt: Date; decidedAt: Date | null;
  revokedAt: Date | null; consumedAt: Date | null; consumedOperationId: string | null; consumedActorId: string | null;
};
type RegisteredWorkspace = {
  id: string; projectId: string; runtimeType: string; provider: string | null;
  providerWorkspaceId: string | null; repositoryUrl: string | null; branch: string | null; projectRepository: string | null;
};

/** Safe review DTO: session identity/generation never leave this server module. */
export type GitApprovalView = {
  id: string;
  action: "git.operation";
  title: string;
  preview: string;
  requestedBy: "owner";
  requestedRole: "owner";
  requestedAt: string;
  status: "pending" | "approved" | "denied" | "revoked" | "expired" | "invalidated" | "consumed";
  decidedAt?: string;
  decidedBy?: "owner";
  expiresAt: string;
  consumedAt?: string;
  scope: GitOperationScope;
};

function conflict(): never {
  throw new ExecutionAuthorizationError(409, "Git approval is not valid for this operation.");
}
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function identity(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= 256;
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof ExecutionAuthorizationError) throw error;
    // Never attach provider/Prisma exceptions, query inputs, or session details.
    throw new ExecutionAuthorizationError(503, "Git approval storage is unavailable.");
  }
}
async function clock(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"
  `;
  return row.now;
}
async function requireSession(session: AuthSession): Promise<Binding> {
  const binding = await resolvePrivateOwnerBinding(session);
  if (!binding) throw new ExecutionAuthorizationError(401);
  return binding;
}

/**
 * Rotation/revoke-all lock owner then session. Match that order and hold share
 * locks until the approval mutation commits, so security changes serialize.
 * The private proof is resolved before entering the transaction, then the
 * corresponding live rows are checked again under locks using database time.
 */
async function lockSession(tx: Tx, binding: Binding): Promise<Date> {
  const [owner] = await tx.$queryRaw<Array<{ credentialVersion: number }>>`
    SELECT "credentialVersion" FROM "OwnerCredential" WHERE "id" = 'owner' FOR SHARE
  `;
  const [session] = await tx.$queryRaw<Array<{
    ownerId: string; credentialVersion: number; revokedAt: Date | null; expiresAt: Date;
  }>>`SELECT "ownerId", "credentialVersion", "revokedAt", "expiresAt"
    FROM "AuthSession" WHERE "id" = ${binding.sessionId} FOR SHARE`;
  if (!owner || !session || binding.ownerId !== "owner" || session.ownerId !== "owner" ||
      owner.credentialVersion !== binding.credentialVersion || session.credentialVersion !== binding.credentialVersion ||
      session.revokedAt || session.expiresAt <= await clock(tx)) throw new ExecutionAuthorizationError(401);
  return session.expiresAt;
}

/** A brief table share lock also excludes duplicate-provider-ID insert phantoms. */
async function lockWorkspace(tx: Tx, projectId: string): Promise<RegisteredWorkspace | null> {
  if (!identity(projectId)) return null;
  const projects = await tx.$queryRaw<Array<{ id: string; repository: string | null }>>`
    SELECT "id", "repository" FROM "Project" WHERE "id" = ${projectId} FOR SHARE
  `;
  if (projects.length !== 1) return null;
  await tx.$executeRaw`LOCK TABLE "Workspace" IN SHARE MODE`;
  const rows = await tx.$queryRaw<RegisteredWorkspace[]>`
    SELECT "id", "projectId", "runtimeType", "provider", "providerWorkspaceId", "repositoryUrl", "branch"
    FROM "Workspace" WHERE "projectId" = ${projectId} FOR SHARE
  `;
  const row = rows[0];
  if (rows.length !== 1 || row.runtimeType !== "cloud" || row.provider !== "daytona" ||
      !identity(row.id) || !identity(row.providerWorkspaceId)) return null;
  const [count] = await tx.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::integer AS "count" FROM "Workspace"
    WHERE "provider" = 'daytona' AND "providerWorkspaceId" = ${row.providerWorkspaceId}
  `;
  return count.count === 1 ? { ...row, projectRepository: projects[0].repository } : null;
}
function contextMatches(context: ExecutionAuthorizationContext, row: RegisteredWorkspace | null): row is RegisteredWorkspace {
  return row !== null && context.projectId === row.projectId && context.workspace.id === row.id &&
    context.workspace.runtimeType === "cloud" && context.workspace.provider === "daytona" &&
    context.workspace.providerWorkspaceId === row.providerWorkspaceId &&
    context.workspace.repositoryUrl === row.repositoryUrl && context.workspace.branch === row.branch;
}
function repositoryKey(workspace: RegisteredWorkspace): string | null {
  try {
    const project = canonicalGitRepository(workspace.projectRepository ?? "");
    const runtime = canonicalGitRepository(workspace.repositoryUrl ?? "");
    return project.key === runtime.key ? project.key : null;
  } catch { return null; }
}
function scopeMatchesWorkspace(scope: GitOperationScope, workspace: RegisteredWorkspace | null): boolean {
  return workspace !== null && scope.ownerId === "owner" && scope.projectId === workspace.projectId &&
    scope.workspaceRecordId === workspace.id && scope.providerWorkspaceId === workspace.providerWorkspaceId &&
    scope.repositoryKey === repositoryKey(workspace) && scope.branch === workspace.branch;
}
function scopeMatches(row: ApprovalRow, binding: Binding, workspace: RegisteredWorkspace | null,
  intended?: GitOperationScope): boolean {
  try {
    const scope = validateGitOperationScope(row.scope);
    return row.ownerId === "owner" && row.sessionId === binding.sessionId &&
      row.credentialVersion === binding.credentialVersion && row.projectId === scope.projectId &&
      row.workspaceRecordId === scope.workspaceRecordId && row.providerWorkspaceId === scope.providerWorkspaceId &&
      row.repositoryKey === scope.repositoryKey && row.operationKey === scope.operationKey &&
      isGitMutation(scope.operationKey) && scopeMatchesWorkspace(scope, workspace) &&
      row.scopeDigest === gitScopeDigest(scope) && (!intended || row.scopeDigest === gitScopeDigest(intended));
  } catch { return false; }
}
function view(row: ApprovalRow, now: Date, validScope = true): GitApprovalView {
  const scope = validateGitOperationScope(row.scope);
  const status = row.status === "REVOKED" ? "revoked" : row.status === "DENIED" ? "denied" :
    !validScope ? "invalidated" : row.consumedAt ? "consumed" : row.expiresAt <= now ? "expired" :
      row.status === "APPROVED" ? "approved" : "pending";
  return { id: row.id, action: "git.operation", title: `Git ${row.operationKey}: ${scope.repositoryKey} (${scope.branch})`,
    preview: JSON.stringify(scope, null, 2), requestedBy: "owner", requestedRole: "owner",
    requestedAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), status,
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString(), decidedBy: "owner" as const } : {}),
    ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}), scope };
}
async function readApproval(tx: Tx, id: string, forUpdate = false): Promise<ApprovalRow | null> {
  const rows = forUpdate ? await tx.$queryRaw<ApprovalRow[]>`
    SELECT * FROM "GitApproval" WHERE "id" = ${id}::uuid FOR UPDATE
  ` : await tx.$queryRaw<ApprovalRow[]>`SELECT * FROM "GitApproval" WHERE "id" = ${id}::uuid`;
  return rows[0] ?? null;
}

/** Only a genuine server-minted execution capability can establish scope. */
export async function createPrivateGitApproval(context: ExecutionAuthorizationContext, proposedScope: GitOperationScope): Promise<GitApprovalView> {
  return safe(async () => {
    const binding = await resolveExecutionSessionBinding(context, "write");
    const scope = validateGitOperationScope(proposedScope);
    if (!isGitMutation(scope.operationKey) || !context.permissions.includes("write")) {
      throw new ExecutionAuthorizationError(403);
    }
    return prisma.$transaction(async (tx) => {
      const sessionExpiresAt = await lockSession(tx, binding);
      const workspace = await lockWorkspace(tx, context.projectId);
      if (!contextMatches(context, workspace) || !scopeMatchesWorkspace(scope, workspace)) conflict();
      const now = await clock(tx);
      if (sessionExpiresAt <= now || context.signal.aborted) throw new ExecutionAuthorizationError(401);
      const expiresAt = new Date(Math.min(now.getTime() + PRIVATE_GIT_APPROVAL_TTL_MS, sessionExpiresAt.getTime()));
      const [row] = await tx.$queryRaw<ApprovalRow[]>`
        INSERT INTO "GitApproval" ("id", "ownerId", "sessionId", "credentialVersion", "projectId",
          "workspaceRecordId", "providerWorkspaceId", "repositoryKey", "operationKey", "scope", "scopeDigest", "createdAt", "expiresAt")
        VALUES (${randomUUID()}::uuid, 'owner', ${binding.sessionId}, ${binding.credentialVersion}, ${workspace.projectId},
          ${workspace.id}, ${workspace.providerWorkspaceId}, ${scope.repositoryKey}, ${scope.operationKey},
          ${JSON.stringify(scope)}::jsonb, ${gitScopeDigest(scope)}, ${now}, ${expiresAt}) RETURNING *
      `;
      return view(row, now);
    }, TRANSACTION_OPTIONS);
  });
}

/** Decisions are immutable except explicit revocation, including consumed grants. */
export async function decidePrivateGitApproval(session: AuthSession, id: string,
  decision: "approved" | "denied" | "revoked"): Promise<GitApprovalView | null> {
  return safe(async () => {
    const binding = await requireSession(session);
    if (!uuid(id)) return null;
    if (!["approved", "denied", "revoked"].includes(decision)) conflict();
    return prisma.$transaction(async (tx) => {
      const sessionExpiresAt = await lockSession(tx, binding);
      const initial = await readApproval(tx, id);
      if (!initial) return null;
      const workspace = await lockWorkspace(tx, initial.projectId);
      const row = await readApproval(tx, id, true);
      const now = await clock(tx);
      if (sessionExpiresAt <= now) throw new ExecutionAuthorizationError(401);
      if (!row || !scopeMatches(row, binding, workspace) || row.expiresAt <= now) conflict();
      if (row.status.toLowerCase() === decision) return view(row, now);
      if (decision === "revoked" ? !["PENDING", "APPROVED"].includes(row.status) : row.status !== "PENDING") conflict();
      const [updated] = decision === "revoked" ? await tx.$queryRaw<ApprovalRow[]>`
        UPDATE "GitApproval" SET "status" = 'REVOKED', "decidedAt" = COALESCE("decidedAt", ${now}),
          "revokedAt" = ${now} WHERE "id" = ${id}::uuid RETURNING *
      ` : await tx.$queryRaw<ApprovalRow[]>`
        UPDATE "GitApproval" SET "status" = ${decision.toUpperCase()}::"CommandApprovalStatus", "decidedAt" = ${now}
        WHERE "id" = ${id}::uuid RETURNING *
      `;
      return view(updated, now);
    }, TRANSACTION_OPTIONS);
  });
}

/** Only this authenticated device's approvals are returned; no session DTO leaks. */
export async function listPrivateGitApprovals(session: AuthSession, limit = 100): Promise<GitApprovalView[]> {
  return safe(async () => {
    const binding = await requireSession(session);
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    return prisma.$transaction(async (tx) => {
      const sessionExpiresAt = await lockSession(tx, binding);
      const rows = await tx.$queryRaw<Array<ApprovalRow & {
        currentWorkspaceId: string | null; currentProjectRepository: string | null;
        currentRepositoryUrl: string | null; currentBranch: string | null;
        currentProviderWorkspaceId: string | null; currentRuntimeType: string | null;
        currentProvider: string | null; associationCount: number;
      }>>`
        SELECT a.*, w."id" AS "currentWorkspaceId", p."repository" AS "currentProjectRepository",
          w."repositoryUrl" AS "currentRepositoryUrl", w."branch" AS "currentBranch",
          w."providerWorkspaceId" AS "currentProviderWorkspaceId", w."runtimeType" AS "currentRuntimeType",
          w."provider" AS "currentProvider",
          (SELECT count(*)::integer FROM "Workspace" x WHERE x."provider" = 'daytona'
            AND x."providerWorkspaceId" = w."providerWorkspaceId") AS "associationCount"
        FROM "GitApproval" a LEFT JOIN "Project" p ON p."id" = a."projectId"
          LEFT JOIN "Workspace" w ON w."projectId" = p."id"
        WHERE a."ownerId" = 'owner' AND a."sessionId" = ${binding.sessionId}
        ORDER BY a."createdAt" DESC, a."id" DESC LIMIT ${count}
      `;
      const now = await clock(tx);
      if (sessionExpiresAt <= now) throw new ExecutionAuthorizationError(401);
      // Review DTOs grant no authority. Consumption/decision separately take
      // registration locks; this read does not hold table locks across projects.
      return rows.map((row) => {
        const workspace: RegisteredWorkspace | null = row.currentWorkspaceId && row.associationCount === 1 &&
          row.currentRuntimeType === "cloud" && row.currentProvider === "daytona" ? {
            id: row.currentWorkspaceId, projectId: row.projectId, runtimeType: row.currentRuntimeType,
            provider: row.currentProvider, providerWorkspaceId: row.currentProviderWorkspaceId,
            repositoryUrl: row.currentRepositoryUrl, branch: row.currentBranch,
            projectRepository: row.currentProjectRepository,
          } : null;
        return view(row, now, scopeMatches(row, binding, workspace));
      });

    }, TRANSACTION_OPTIONS);
  });
}

async function validateReceiptOrConsume(context: ExecutionAuthorizationContext, proposedScope: GitOperationScope, approvalId: string,
  operationId: string, actorId: string, consume: boolean): Promise<boolean> {
  return safe(async () => {
    const binding = await resolveExecutionSessionBinding(context, "write");
    const scope = validateGitOperationScope(proposedScope);
    if (!uuid(approvalId) || !uuid(operationId) || !isGitMutation(scope.operationKey) ||
        typeof actorId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(actorId) || !context.permissions.includes("write")) return false;
    return prisma.$transaction(async (tx) => {
      const sessionExpiresAt = await lockSession(tx, binding);
      const workspace = await lockWorkspace(tx, context.projectId);
      if (!contextMatches(context, workspace) || !scopeMatchesWorkspace(scope, workspace)) return false;
      if (consume) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cr8or-git-approval:${operationId}`}, 0))::text`;
        const receipts = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "GitApproval" WHERE "consumedOperationId" = ${operationId}::uuid
        `;
        if (receipts.length !== 0) return false;
      }
      const row = await readApproval(tx, approvalId, true);
      const now = await clock(tx);
      if (sessionExpiresAt <= now || context.signal.aborted) throw new ExecutionAuthorizationError(401);
      if (!row || !scopeMatches(row, binding, workspace, scope) || row.status !== "APPROVED" ||
          row.revokedAt || row.expiresAt <= now) return false;
      if (!consume) return !!row.consumedAt && row.consumedOperationId === operationId && row.consumedActorId === actorId;
      if (row.consumedAt) return false;
      // The row lock serializes contenders across application instances. The
      // predicates remain explicit and the unique operation receipt prevents
      // reusing one operation ID to consume another approval.
      const updated = await tx.$executeRaw`
        UPDATE "GitApproval" SET "consumedAt" = ${now}, "consumedOperationId" = ${operationId}::uuid,
          "consumedActorId" = ${actorId}
        WHERE "id" = ${approvalId}::uuid AND "status" = 'APPROVED' AND "consumedAt" IS NULL
      `;
      return updated === 1;
    }, TRANSACTION_OPTIONS);
  });
}

/** A legacy action-only approval has no row here and cannot be upgraded. */
export async function consumePrivateGitApproval(context: ExecutionAuthorizationContext, scope: GitOperationScope,
  approvalId: string, operationId: string, actorId: string): Promise<boolean> {
  return validateReceiptOrConsume(context, scope, approvalId, operationId, actorId, true);
}

/** Rechecking a consumed receipt never consumes a second approval or authorizes a different operation. */
export async function validateConsumedPrivateGitApproval(context: ExecutionAuthorizationContext, scope: GitOperationScope,
  approvalId: string, operationId: string, actorId: string): Promise<boolean> {
  return validateReceiptOrConsume(context, scope, approvalId, operationId, actorId, false);
}
