import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { PrivateOwnerSessionBinding } from "@/lib/security/auth";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { canonicalGitRepository } from "@/lib/security/git-operation-catalogue";
import {
  validateWorkspaceLifecycleScope, workspaceLifecycleScopeDigest, type WorkspaceLifecycleScope,
} from "@/lib/security/workspace-lifecycle-catalogue";

export type LifecycleBinding = Pick<PrivateOwnerSessionBinding, "ownerId" | "sessionId" | "credentialVersion">;
export type LifecycleStatus = "RESERVED" | "DISPATCHED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
export const LIFECYCLE_DISPATCH_DEADLINE_MS = 60_000;
export const LIFECYCLE_APPROVAL_TTL_MS = 10 * 60_000;
export const LIFECYCLE_MAX_PENDING = 4;
export const LIFECYCLE_MAX_PROVISIONING = 1;
export const LIFECYCLE_MAX_CREATIONS = 3;
export const LIFECYCLE_CREATION_WINDOW_MS = 15 * 60_000;
export const LIFECYCLE_MAX_PROJECT_MUTATIONS = 6;
export const LIFECYCLE_PROJECT_WINDOW_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTIONS = { isolationLevel: "ReadCommitted" as const, maxWait: 5_000, timeout: 5_000 };
type Tx = Prisma.TransactionClient;
type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "REVOKED";
type Snapshot = {
  id: string; ownerId: string; sessionId: string; credentialVersion: number;
  projectId: string; workspaceRecordId: string; providerWorkspaceId: string | null;
  action: WorkspaceLifecycleScope["action"]; scope: WorkspaceLifecycleScope; scopeDigest: string;
  createdAt: Date;
};
type ApprovalRow = Snapshot & {
  status: ApprovalStatus; expiresAt: Date; decidedAt: Date | null; revokedAt: Date | null;
  consumedAt: Date | null; consumedOperationId: string | null;
};
export type LifecycleOperation = Snapshot & {
  providerResourceId: string | null; idempotencyKey: string; approvalId: string | null;
  status: LifecycleStatus; attempts: number; dispatchedAt: Date | null; completedAt: Date | null;
  updatedAt: Date; reconciledAt: Date | null; reconciliationAttempts: number; lastReconciliationAt: Date | null;
};
export type LifecycleApprovalView = {
  id: string; action: "workspace.lifecycle"; title: string; preview: string;
  requestedBy: "owner"; requestedRole: "owner"; requestedAt: string; expiresAt: string;
  status: "pending" | "approved" | "denied" | "revoked" | "expired" | "invalidated" | "consumed";
  decidedAt?: string; decidedBy?: "owner"; consumedAt?: string; scope: WorkspaceLifecycleScope;
};
/** Provider evidence is produced by the trusted adapter, never parsed from an API body. */
export type VerifiedLifecycleResource = {
  /** Server-derived metadata evidence; required before persisting a ready state. */
  isolationVerified: boolean;
  id: string; state: "started" | "stopped"; repositoryKey: string | null; branch: string | null;
  reservationId: string; projectId: string;
};
function conflict(): never { throw new ExecutionAuthorizationError(409, "Workspace lifecycle operation cannot proceed."); }
function validIdentity(value: unknown, max = 256): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= max;
}
function requireId(id: unknown): asserts id is string { if (typeof id !== "string" || !UUID.test(id)) conflict(); }
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof ExecutionAuthorizationError) throw error;
    throw new ExecutionAuthorizationError(503, "Workspace lifecycle storage is unavailable.");
  }
}
async function clock(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"`;
  return row.now;
}
async function lockSession(tx: Tx, binding: LifecycleBinding): Promise<Date> {
  if (!binding || binding.ownerId !== "owner" || !validIdentity(binding.sessionId, 128) ||
      !Number.isInteger(binding.credentialVersion) || binding.credentialVersion < 1) throw new ExecutionAuthorizationError(401);
  const [owner] = await tx.$queryRaw<Array<{ credentialVersion: number }>>`
    SELECT "credentialVersion" FROM "OwnerCredential" WHERE "id" = 'owner' FOR SHARE`;
  const [session] = await tx.$queryRaw<Array<{ ownerId: string; credentialVersion: number; expiresAt: Date; revokedAt: Date | null }>>`
    SELECT "ownerId", "credentialVersion", "expiresAt", "revokedAt" FROM "AuthSession" WHERE "id" = ${binding.sessionId} FOR SHARE`;
  if (!owner || !session || session.ownerId !== "owner" || owner.credentialVersion !== binding.credentialVersion ||
      session.credentialVersion !== binding.credentialVersion || session.revokedAt || session.expiresAt <= await clock(tx)) {
    throw new ExecutionAuthorizationError(401);
  }
  return session.expiresAt;
}

/** A final database-clock check rolls back the whole positive transaction if
 * authorization expires while waiting for locks or applying its mutation. */
async function authorizedTransaction<T>(binding: LifecycleBinding, work: (tx: Tx) => Promise<T>): Promise<T> {
  return safe(() => prisma.$transaction(async (tx) => {
    const result = await work(tx);
    await lockSession(tx, binding);
    return result;
  }, OPTIONS));
}

async function lockCoordinator(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('cr8or-workspace-lifecycle:owner', 0))::text`;
}
function provisioning(scope: WorkspaceLifecycleScope): boolean { return scope.action === "create" || scope.action === "clone"; }
function repository(value: string | null): string | null {
  if (value === null) return null;
  try { return canonicalGitRepository(value).key; } catch { conflict(); }
}
/** Table locks also exclude legacy writers and duplicate-provider-ID phantoms. */
async function registry(tx: Tx, scope: WorkspaceLifecycleScope, registeredResource?: string): Promise<void> {
  await tx.$executeRaw`LOCK TABLE "Project", "Workspace" IN SHARE ROW EXCLUSIVE MODE`;
  const projects = await tx.$queryRaw<Array<{ id: string; repository: string | null }>>`
    SELECT "id", left("repository", 257) AS "repository" FROM "Project" WHERE "id" = ${scope.projectId}`;
  const workspaces = await tx.$queryRaw<Array<{
    id: string; projectId: string; runtimeType: string; provider: string | null;
    providerWorkspaceId: string | null; repositoryUrl: string | null; branch: string | null;
  }>>`SELECT "id", "projectId", "runtimeType", "provider", left("providerWorkspaceId", 257) AS "providerWorkspaceId",
      left("repositoryUrl", 257) AS "repositoryUrl", left("branch", 257) AS "branch"
      FROM "Workspace" WHERE "projectId" = ${scope.projectId} OR "id" = ${scope.workspaceRecordId}`;
  if (provisioning(scope) && !registeredResource) {
    if (projects.length || workspaces.length) conflict();
    if (scope.repositoryKey) {
      // A legacy association must be opened explicitly, never replaced by a
      // newly generated singleton-owner identity or a differently cased URL.
      const rows = await tx.$queryRaw<Array<{ repository: string | null; repositoryUrl: string | null }>>`
        SELECT left(p."repository", 257) AS "repository", left(w."repositoryUrl", 257) AS "repositoryUrl"
        FROM "Project" p LEFT JOIN "Workspace" w ON w."projectId" = p."id"
        WHERE p."repository" IS NOT NULL OR w."repositoryUrl" IS NOT NULL LIMIT 1001`;
      if (rows.length > 1000) conflict();
      for (const row of rows) {
        if (repository(row.repository) === scope.repositoryKey || repository(row.repositoryUrl) === scope.repositoryKey) conflict();
      }
    }
    return;
  }
  const w = workspaces[0];
  const providerId = registeredResource ?? scope.providerWorkspaceId;
  if (projects.length !== 1 || workspaces.length !== 1 || !w || w.id !== scope.workspaceRecordId ||
      w.projectId !== scope.projectId || w.runtimeType !== "cloud" || w.provider !== "daytona" ||
      w.providerWorkspaceId !== providerId || w.branch !== scope.branch ||
      repository(projects[0].repository) !== scope.repositoryKey || repository(w.repositoryUrl) !== scope.repositoryKey) conflict();
  const [duplicates] = await tx.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::integer AS "count" FROM "Workspace" WHERE "provider" = 'daytona' AND "providerWorkspaceId" = ${providerId}`;
  if (duplicates.count !== 1) conflict();
}
function snapshotMatches(row: Snapshot, binding: LifecycleBinding, intended?: WorkspaceLifecycleScope): boolean {
  try {
    const scope = validateWorkspaceLifecycleScope(row.scope);
    return row.ownerId === "owner" && row.sessionId === binding.sessionId && row.credentialVersion === binding.credentialVersion &&
      row.projectId === scope.projectId && row.workspaceRecordId === scope.workspaceRecordId &&
      row.providerWorkspaceId === scope.providerWorkspaceId && row.action === scope.action &&
      row.scopeDigest === workspaceLifecycleScopeDigest(scope) && (!intended || row.scopeDigest === workspaceLifecycleScopeDigest(intended));
  } catch { return false; }
}
function view(row: ApprovalRow, now: Date, valid = true): LifecycleApprovalView {
  const scope = validateWorkspaceLifecycleScope(row.scope);
  return { id: row.id, action: "workspace.lifecycle", title: `Workspace ${scope.action}: ${scope.projectName}`,
    preview: JSON.stringify(scope, null, 2), requestedBy: "owner", requestedRole: "owner", requestedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(), scope,
    status: row.status === "REVOKED" ? "revoked" : row.status === "DENIED" ? "denied" : !valid ? "invalidated" :
      row.consumedAt ? "consumed" : row.expiresAt <= now ? "expired" : row.status === "APPROVED" ? "approved" : "pending",
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString(), decidedBy: "owner" as const } : {}),
    ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}) };
}
async function approval(tx: Tx, id: string): Promise<ApprovalRow | null> {
  const [row] = await tx.$queryRaw<ApprovalRow[]>`SELECT * FROM "WorkspaceLifecycleApproval" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return row ?? null;
}
async function operation(tx: Tx, id: string): Promise<LifecycleOperation | null> {
  const [row] = await tx.$queryRaw<LifecycleOperation[]>`SELECT * FROM "WorkspaceLifecycleOperation" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return row ?? null;
}
async function workspaceSlot(tx: Tx, id: string, ownOperation?: string): Promise<void> {
  if (!validIdentity(id)) conflict();
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cr8or-command:${id}`}, 0))::text`;
  const [count] = await tx.$queryRaw<Array<{ active: number }>>`
    SELECT ((SELECT count(*) FROM "CommandOperation" WHERE "workspaceId" = ${id} AND "status" IN ('RESERVED', 'RUNNING', 'UNKNOWN')) +
      (SELECT count(*) FROM "GitOperation" WHERE "workspaceId" = ${id} AND "status" IN ('RESERVED', 'RUNNING', 'UNKNOWN')) +
      (SELECT count(*) FROM "WorkspaceLifecycleOperation" WHERE ("providerWorkspaceId" = ${id} OR "providerResourceId" = ${id})
        AND "status" IN ('RESERVED', 'DISPATCHED', 'UNKNOWN') AND ("id"::text <> ${ownOperation ?? ""})))::integer AS "active"`;
  if (count.active) conflict();
}

/** Binding is internal DB metadata, not a caller's proof. The service must first
 * extract it from the genuine owner capability; every operation rechecks DB state. */
export async function createLifecycleApproval(binding: LifecycleBinding, proposed: WorkspaceLifecycleScope): Promise<LifecycleApprovalView> {
  return authorizedTransaction(binding, async (tx) => {
    const expires = await lockSession(tx, binding);
    const scope = validateWorkspaceLifecycleScope(proposed);
    await lockCoordinator(tx);
    await registry(tx, scope);
    const now = await clock(tx);
    if (expires <= now) throw new ExecutionAuthorizationError(401);
    const [count] = await tx.$queryRaw<Array<{ pending: number }>>`
      SELECT count(*)::integer AS "pending" FROM "WorkspaceLifecycleApproval"
      WHERE "status" IN ('PENDING', 'APPROVED') AND "consumedAt" IS NULL AND "expiresAt" > ${now}`;
    if (count.pending >= 20) conflict();
    const [row] = await tx.$queryRaw<ApprovalRow[]>`
      INSERT INTO "WorkspaceLifecycleApproval" ("id", "ownerId", "sessionId", "credentialVersion", "projectId", "workspaceRecordId",
        "providerWorkspaceId", "action", "scope", "scopeDigest", "createdAt", "expiresAt")
      VALUES (${randomUUID()}::uuid, 'owner', ${binding.sessionId}, ${binding.credentialVersion}, ${scope.projectId}, ${scope.workspaceRecordId},
        ${scope.providerWorkspaceId}, ${scope.action}, ${JSON.stringify(scope)}::jsonb, ${workspaceLifecycleScopeDigest(scope)},
        ${now}, ${new Date(Math.min(now.getTime() + LIFECYCLE_APPROVAL_TTL_MS, expires.getTime()))}) RETURNING *`;
    return view(row, now);
  });
}
export async function decideLifecycleApproval(binding: LifecycleBinding, id: string, decision: "approved" | "denied" | "revoked"): Promise<LifecycleApprovalView | null> {
  requireId(id);
  if (!["approved", "denied", "revoked"].includes(decision)) conflict();
  return authorizedTransaction(binding, async (tx) => {
    await lockSession(tx, binding);
    await lockCoordinator(tx);
    const row = await approval(tx, id);
    if (!row) return null;
    const now = await clock(tx);
    if (!snapshotMatches(row, binding) || row.expiresAt <= now || (row.consumedAt && decision !== "revoked")) conflict();
    let registeredResource: string | undefined;
    if (row.consumedOperationId && provisioning(row.scope)) {
      const [consumed] = await tx.$queryRaw<Array<{ status: string; providerResourceId: string | null }>>`
        SELECT "status", "providerResourceId" FROM "WorkspaceLifecycleOperation" WHERE "id" = ${row.consumedOperationId}::uuid`;
      if (consumed?.status === "SUCCEEDED") registeredResource = consumed.providerResourceId ?? undefined;
    }
    await registry(tx, row.scope, registeredResource);
    if (row.status.toLowerCase() === decision) return view(row, now);
    if (decision === "revoked" ? !["PENDING", "APPROVED"].includes(row.status) : row.status !== "PENDING") conflict();
    const [updated] = decision === "revoked" ? await tx.$queryRaw<ApprovalRow[]>`
      UPDATE "WorkspaceLifecycleApproval" SET "status" = 'REVOKED', "decidedAt" = COALESCE("decidedAt", ${now}), "revokedAt" = ${now}
      WHERE "id" = ${id}::uuid RETURNING *` : await tx.$queryRaw<ApprovalRow[]>`
      UPDATE "WorkspaceLifecycleApproval" SET "status" = ${decision.toUpperCase()}::"CommandApprovalStatus", "decidedAt" = ${now}
      WHERE "id" = ${id}::uuid RETURNING *`;
    return view(updated, now);
  });
}
export async function listLifecycleApprovals(binding: LifecycleBinding): Promise<LifecycleApprovalView[]> {
  return authorizedTransaction(binding, async (tx) => {
    await lockSession(tx, binding);
    const rows = await tx.$queryRaw<ApprovalRow[]>`
      SELECT * FROM "WorkspaceLifecycleApproval" WHERE "sessionId" = ${binding.sessionId} ORDER BY "createdAt" DESC LIMIT 100`;
    const now = await clock(tx);
    const result: LifecycleApprovalView[] = [];
    for (const row of rows) {
      let valid = snapshotMatches(row, binding);
      if (valid) {
        try {
          let registeredResource: string | undefined;
          if (row.consumedOperationId && provisioning(row.scope)) {
            const [consumed] = await tx.$queryRaw<Array<{ status: string; providerResourceId: string | null }>>`
              SELECT "status", "providerResourceId" FROM "WorkspaceLifecycleOperation" WHERE "id" = ${row.consumedOperationId}::uuid`;
            if (consumed?.status === "SUCCEEDED") registeredResource = consumed.providerResourceId ?? undefined;
          }
          await registry(tx, row.scope, registeredResource);
        } catch (error) {
          if (!(error instanceof ExecutionAuthorizationError)) throw error;
          valid = false;
        }
      }
      try { result.push(view(row, now, valid)); }
      catch (error) { if (!(error instanceof ExecutionAuthorizationError)) throw error; }
    }
    return result;
  });
}
export async function reserveLifecycleOperation(binding: LifecycleBinding, proposed: WorkspaceLifecycleScope,
  input: { idempotencyKey: string; approvalId?: string; requiresApproval: boolean }): Promise<{ operation: LifecycleOperation; reused: boolean }> {
  requireId(input?.idempotencyKey);
  if (typeof input.requiresApproval !== "boolean") conflict();
  if (input.approvalId !== undefined) requireId(input.approvalId);
  return authorizedTransaction(binding, async (tx) => {
    await lockSession(tx, binding);
    const scope = validateWorkspaceLifecycleScope(proposed);
    await lockCoordinator(tx);
    const [prior] = await tx.$queryRaw<LifecycleOperation[]>`
      SELECT * FROM "WorkspaceLifecycleOperation" WHERE "sessionId" = ${binding.sessionId} AND "idempotencyKey" = ${input.idempotencyKey}::uuid FOR UPDATE`;
    if (prior) {
      if (!snapshotMatches(prior, binding, scope) || prior.approvalId !== (input.approvalId ?? null)) conflict();
      await registry(tx, scope, prior.status === "SUCCEEDED" && provisioning(scope) ? prior.providerResourceId ?? undefined : undefined);
      // Return existing receipt, never dispatch again or reclaim its slot.
      return { operation: prior, reused: true };
    }
    if (scope.providerWorkspaceId) await workspaceSlot(tx, scope.providerWorkspaceId);
    await registry(tx, scope);
    const now = await clock(tx);
    const [counts] = await tx.$queryRaw<Array<{ pending: number; provisioning: number; creations: number; recent: number }>>`
      SELECT count(*) FILTER (WHERE "status" IN ('RESERVED', 'DISPATCHED', 'UNKNOWN'))::integer AS "pending",
        count(*) FILTER (WHERE "action" IN ('create', 'clone') AND "status" IN ('RESERVED', 'DISPATCHED', 'UNKNOWN'))::integer AS "provisioning",
        count(*) FILTER (WHERE "action" IN ('create', 'clone') AND "createdAt" > ${new Date(now.getTime() - LIFECYCLE_CREATION_WINDOW_MS)})::integer AS "creations",
        count(*) FILTER (WHERE "projectId" = ${scope.projectId} AND "createdAt" > ${new Date(now.getTime() - LIFECYCLE_PROJECT_WINDOW_MS)})::integer AS "recent"
      FROM "WorkspaceLifecycleOperation"`;
    if (counts.pending >= LIFECYCLE_MAX_PENDING || counts.recent >= LIFECYCLE_MAX_PROJECT_MUTATIONS ||
        (provisioning(scope) && (counts.provisioning >= LIFECYCLE_MAX_PROVISIONING || counts.creations >= LIFECYCLE_MAX_CREATIONS))) conflict();
    const id = randomUUID();
    if (input.requiresApproval || input.approvalId) {
      if (!input.approvalId) conflict();
      const approved = await approval(tx, input.approvalId);
      if (!approved || !snapshotMatches(approved, binding, scope) || approved.status !== "APPROVED" ||
          approved.consumedAt || approved.expiresAt <= now) conflict();
      await tx.$executeRaw`UPDATE "WorkspaceLifecycleApproval" SET "consumedAt" = ${now}, "consumedOperationId" = ${id}::uuid
        WHERE "id" = ${approved.id}::uuid`;
    }
    const [row] = await tx.$queryRaw<LifecycleOperation[]>`
      INSERT INTO "WorkspaceLifecycleOperation" ("id", "ownerId", "sessionId", "credentialVersion", "projectId", "workspaceRecordId", "providerWorkspaceId",
        "action", "scope", "scopeDigest", "idempotencyKey", "approvalId", "createdAt", "updatedAt")
      VALUES (${id}::uuid, 'owner', ${binding.sessionId}, ${binding.credentialVersion}, ${scope.projectId}, ${scope.workspaceRecordId}, ${scope.providerWorkspaceId},
        ${scope.action}, ${JSON.stringify(scope)}::jsonb, ${workspaceLifecycleScopeDigest(scope)}, ${input.idempotencyKey}::uuid,
        ${input.approvalId ?? null}::uuid, ${now}, ${now}) RETURNING *`;
    return { operation: row, reused: false };
  });
}
async function authorizedOperation(tx: Tx, binding: LifecycleBinding, id: string): Promise<LifecycleOperation> {
  await lockSession(tx, binding);
  await lockCoordinator(tx);
  const row = await operation(tx, id);
  if (!row || !snapshotMatches(row, binding)) conflict();
  return row;
}
async function validConsumedApproval(tx: Tx, row: LifecycleOperation, binding: LifecycleBinding, now: Date, dispatch: boolean): Promise<void> {
  if (!row.approvalId) return;
  const approved = await approval(tx, row.approvalId);
  if (!approved || !snapshotMatches(approved, binding, row.scope) || approved.status !== "APPROVED" ||
      approved.consumedOperationId !== row.id || !approved.consumedAt || (dispatch && approved.expiresAt <= now)) conflict();
}
export async function markLifecycleDispatched(binding: LifecycleBinding, id: string): Promise<LifecycleOperation> {
  requireId(id);
  return authorizedTransaction(binding, async (tx) => {
    const row = await authorizedOperation(tx, binding, id);
    if (row.status !== "RESERVED" || row.attempts !== 0) conflict();
    if (row.providerWorkspaceId) await workspaceSlot(tx, row.providerWorkspaceId, id);
    await registry(tx, row.scope);
    const now = await clock(tx);
    if (row.createdAt.getTime() + LIFECYCLE_DISPATCH_DEADLINE_MS <= now.getTime()) conflict();
    await lockSession(tx, binding);
    await validConsumedApproval(tx, row, binding, now, true);
    const [updated] = await tx.$queryRaw<LifecycleOperation[]>`
      UPDATE "WorkspaceLifecycleOperation" SET "status" = 'DISPATCHED', "attempts" = 1, "dispatchedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${id}::uuid RETURNING *`;
    return updated;
  });
}
async function validateResourceIdentity(tx: Tx, row: LifecycleOperation, providerId: string): Promise<void> {
  if (!validIdentity(providerId) || (row.providerWorkspaceId && row.providerWorkspaceId !== providerId) ||
      (row.providerResourceId && row.providerResourceId !== providerId)) conflict();
  await workspaceSlot(tx, providerId, row.id);
  await tx.$executeRaw`LOCK TABLE "Project", "Workspace" IN SHARE ROW EXCLUSIVE MODE`;
  const conflicts = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Workspace" WHERE "provider" = 'daytona' AND "providerWorkspaceId" = ${providerId}
      AND ("id" <> ${row.workspaceRecordId} OR "projectId" <> ${row.projectId}) LIMIT 1`;
  if (conflicts.length) conflict();
}
export async function recordLifecycleResource(binding: LifecycleBinding, id: string, providerId: string): Promise<LifecycleOperation> {
  requireId(id);
  return authorizedTransaction(binding, async (tx) => {
    const row = await authorizedOperation(tx, binding, id);
    if (!["DISPATCHED", "UNKNOWN"].includes(row.status)) conflict();
    await validateResourceIdentity(tx, row, providerId);
    const [updated] = await tx.$queryRaw<LifecycleOperation[]>`
      UPDATE "WorkspaceLifecycleOperation" SET "providerResourceId" = ${providerId}, "updatedAt" = ${await clock(tx)}
      WHERE "id" = ${id}::uuid RETURNING *`;
    return updated;
  });
}
async function complete(binding: LifecycleBinding, id: string, evidence: VerifiedLifecycleResource, reconciliation: boolean): Promise<LifecycleOperation> {
  requireId(id);
  return authorizedTransaction(binding, async (tx) => {
    const row = await authorizedOperation(tx, binding, id);
    if (!evidence || evidence.reservationId !== row.id || evidence.projectId !== row.projectId ||
        evidence.repositoryKey !== row.scope.repositoryKey || evidence.branch !== row.scope.branch ||
        evidence.state !== (row.action === "stop" ? "stopped" : "started") ||
        typeof evidence.isolationVerified !== "boolean" || (row.action !== "stop" && evidence.isolationVerified !== true)) conflict();
    if (row.status === "SUCCEEDED") {
      if (row.providerResourceId !== evidence.id) conflict();
      await registry(tx, row.scope, provisioning(row.scope) ? evidence.id : undefined);
      return row;
    }
    const observedAt = await clock(tx);
    if (reconciliation && (row.reconciliationAttempts < 1 || row.lastReconciliationAt === null ||
        row.lastReconciliationAt.getTime() + LIFECYCLE_DISPATCH_DEADLINE_MS <= observedAt.getTime())) conflict();
    const dispatchedExpired = row.status === "DISPATCHED" && row.dispatchedAt !== null &&
      row.dispatchedAt.getTime() + LIFECYCLE_DISPATCH_DEADLINE_MS <= observedAt.getTime();
    if (reconciliation ? row.status !== "UNKNOWN" && !dispatchedExpired : row.status !== "DISPATCHED" || dispatchedExpired) conflict();
    await validateResourceIdentity(tx, row, evidence.id);
    await registry(tx, row.scope);
    const now = await clock(tx);
    await validConsumedApproval(tx, row, binding, now, false);
    await lockSession(tx, binding);
    if (provisioning(row.scope)) {
      await tx.$executeRaw`
        INSERT INTO "Project" ("id", "name", "description", "framework", "language", "repository", "createdAt", "updatedAt")
        VALUES (${row.projectId}, ${row.scope.projectName}, 'Private owner workspace', 'unknown', 'unknown', ${row.scope.repositoryUrl}, ${now}, ${now})`;
      await tx.$executeRaw`
        INSERT INTO "Workspace" ("id", "projectId", "runtimeType", "provider", "providerWorkspaceId", "repositoryUrl", "projectName", "branch", "state", "createdAt", "updatedAt")
        VALUES (${row.workspaceRecordId}, ${row.projectId}, 'cloud', 'daytona', ${evidence.id}, ${row.scope.repositoryUrl}, ${row.scope.projectName}, ${row.scope.branch}, ${evidence.state === "started" ? "ready" : "stopped"}, ${now}, ${now})`;
    } else {
      await tx.$executeRaw`UPDATE "Workspace" SET "state" = ${evidence.state === "started" ? "ready" : "stopped"}, "updatedAt" = ${now} WHERE "id" = ${row.workspaceRecordId}`;
    }
    const [updated] = await tx.$queryRaw<LifecycleOperation[]>`
      UPDATE "WorkspaceLifecycleOperation" SET "status" = 'SUCCEEDED', "providerResourceId" = ${evidence.id}, "completedAt" = ${now},
        "updatedAt" = ${now}, "reconciledAt" = ${reconciliation ? now : null} WHERE "id" = ${id}::uuid RETURNING *`;
    return updated;
  });
}
export function completeLifecycleOperation(binding: LifecycleBinding, id: string, evidence: VerifiedLifecycleResource): Promise<LifecycleOperation> {
  return complete(binding, id, evidence, false);
}
export function reconcileLifecycleOperation(binding: LifecycleBinding, id: string, evidence: VerifiedLifecycleResource): Promise<LifecycleOperation> {
  return complete(binding, id, evidence, true);
}
/** Failure recording deliberately grants no authority and must remain possible
 * after revocation. A dispatched request can only become UNKNOWN, never retryable. */
export async function failLifecycleOperation(id: string, dispatched: boolean): Promise<LifecycleOperation> {
  requireId(id);
  if (typeof dispatched !== "boolean") conflict();
  return safe(() => prisma.$transaction(async (tx) => {
    await lockCoordinator(tx);
    const row = await operation(tx, id);
    if (!row) conflict();
    const status = row.attempts === 1 || dispatched ? "UNKNOWN" : "FAILED";
    if (row.status === status) return row;
    if (!["RESERVED", "DISPATCHED"].includes(row.status) || (dispatched && row.attempts !== 1)) conflict();
    const now = await clock(tx);
    const [updated] = await tx.$queryRaw<LifecycleOperation[]>`
      UPDATE "WorkspaceLifecycleOperation" SET "status" = ${status}::"WorkspaceLifecycleStatus", "completedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${id}::uuid RETURNING *`;
    return updated;
  }, OPTIONS));
}
export async function readLifecycleOperation(binding: LifecycleBinding, id: string): Promise<LifecycleOperation | null> {
  requireId(id);
  return authorizedTransaction(binding, async (tx) => {
    await lockSession(tx, binding);
    const [row] = await tx.$queryRaw<LifecycleOperation[]>`SELECT * FROM "WorkspaceLifecycleOperation" WHERE "id" = ${id}::uuid`;
    if (!row) return null;
    if (!snapshotMatches(row, binding)) return null;
    return row;
  });
}

/** A crashed reservation is cancellable only before any dispatch claim and after
 * its fixed deadline. Cancellation never retries or deletes provider resources. */
export async function cancelReservedLifecycleOperation(binding: LifecycleBinding, id: string): Promise<LifecycleOperation> {
  requireId(id);
  return authorizedTransaction(binding, async (tx) => {
    const row = await authorizedOperation(tx, binding, id);
    if (row.status === "CANCELLED") return row;
    const now = await clock(tx);
    if (row.status !== "RESERVED" || row.attempts !== 0 || row.createdAt.getTime() + LIFECYCLE_DISPATCH_DEADLINE_MS > now.getTime()) conflict();
    const [updated] = await tx.$queryRaw<LifecycleOperation[]>`
      UPDATE "WorkspaceLifecycleOperation" SET "status" = 'CANCELLED', "completedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${id}::uuid RETURNING *`;
    return updated;
  });
}

/** Rechecked by the provider callback immediately before every mutating SDK
 * dispatch. Possessing a reservation receipt does not confer this authority. */
export async function assertLifecycleDispatch(binding: LifecycleBinding, id: string): Promise<void> {
  requireId(id);
  return authorizedTransaction(binding, async (tx) => {
    const row = await authorizedOperation(tx, binding, id);
    const now = await clock(tx);
    if (row.status !== "DISPATCHED" || row.dispatchedAt === null ||
        row.dispatchedAt.getTime() + LIFECYCLE_DISPATCH_DEADLINE_MS <= now.getTime()) conflict();
    const providerId = row.providerResourceId ?? row.providerWorkspaceId;
    if (providerId) await workspaceSlot(tx, providerId, id);
    await registry(tx, row.scope);
    await validConsumedApproval(tx, row, binding, now, true);
    await lockSession(tx, binding);
  });
}

/** Bounded database housekeeping only: consumed approvals and every operation
 * receipt remain for audit/idempotency. No provider resource or unresolved
 * operation is ever deleted, retried, remapped, or reclaimed by housekeeping. */
export async function cleanupLifecycleRecords(binding: LifecycleBinding, retentionDays = 30): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) conflict();
  return authorizedTransaction(binding, async (tx) => {
    await lockSession(tx, binding);
    await lockCoordinator(tx);
    const now = await clock(tx);
    return tx.$executeRaw`
      WITH expired AS (
        SELECT "id" FROM "WorkspaceLifecycleApproval"
        WHERE "consumedAt" IS NULL AND "expiresAt" < ${now} - ${retentionDays} * INTERVAL '1 day'
        ORDER BY "expiresAt" LIMIT 100 FOR UPDATE SKIP LOCKED
      ) DELETE FROM "WorkspaceLifecycleApproval" WHERE "id" IN (SELECT "id" FROM expired)`;
  });
}

/** Read-only provider reconciliation is itself bounded across instances. A
 * failed/ambiguous lookup consumes an attempt; this never redispatches creation. */
export async function claimLifecycleReconciliation(binding: LifecycleBinding, id: string): Promise<LifecycleOperation> {
  requireId(id);
  return authorizedTransaction(binding, async (tx) => {
    const row = await authorizedOperation(tx, binding, id);
    const now = await clock(tx);
    if ((row.status !== "UNKNOWN" && (row.status !== "DISPATCHED" || row.dispatchedAt === null ||
          row.dispatchedAt.getTime() + LIFECYCLE_DISPATCH_DEADLINE_MS > now.getTime())) ||
        row.reconciliationAttempts >= 3 || (row.lastReconciliationAt && row.lastReconciliationAt.getTime() + 60_000 > now.getTime())) conflict();
    if (row.providerResourceId ?? row.providerWorkspaceId) await workspaceSlot(tx, (row.providerResourceId ?? row.providerWorkspaceId)!, id);
    await registry(tx, row.scope);
    await validConsumedApproval(tx, row, binding, now, false);
    const [updated] = await tx.$queryRaw<LifecycleOperation[]>`
      UPDATE "WorkspaceLifecycleOperation" SET "reconciliationAttempts" = "reconciliationAttempts" + 1,
        "lastReconciliationAt" = ${now}, "updatedAt" = ${now} WHERE "id" = ${id}::uuid RETURNING *`;
    return updated;
  });
}
