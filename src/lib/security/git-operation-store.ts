import "server-only";

import { prisma } from "@/lib/db/prisma";
import { isGitMutation } from "@/lib/security/git-operation-catalogue";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GIT_MAX_STARTS_PER_WINDOW = 6;
export const GIT_WINDOW_MS = 5 * 60 * 1_000;
export const GIT_MAX_CONCURRENT_PER_WORKSPACE = 1;

export type GitOperationStatus = "RESERVED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "UNKNOWN";
export type GitOperation = {
  id: string;
  projectId: string;
  /** Exact Daytona provider workspace identifier, never a client selection. */
  workspaceId: string;
  repositoryKey: string;
  operationKey: string;
  scopeDigest: string;
  actorId: string;
  executionId: string;
  status: GitOperationStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  exitCode: number | null;
  cancellationConfirmed: boolean;
  cleanupConfirmed: boolean;
};
export type ReserveGitOperationInput = Pick<GitOperation,
  "id" | "projectId" | "workspaceId" | "repositoryKey" | "operationKey" | "scopeDigest" | "actorId" | "executionId">;
export type FinishGitOperationInput = {
  status: Exclude<GitOperationStatus, "RESERVED" | "RUNNING">;
  exitCode?: number;
  cancellationConfirmed?: boolean;
  cleanupConfirmed?: boolean;
};

function conflict(): never {
  throw new ExecutionAuthorizationError(409, "Git operation cannot proceed.");
}

function requireId(id: string): void {
  if (typeof id !== "string" || !UUID.test(id)) conflict();
}

function validIdentity(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 256;
}

async function withStoreErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) throw error;
    // Prisma errors can include queries, credentials, and connection details.
    throw new ExecutionAuthorizationError(503, "Git coordination is unavailable.");
  }
}

/**
 * Persistence is not authentication. Only the trusted dispatcher calls this
 * after capability/policy validation. Transaction locking and the partial
 * unique index coordinate all Vercel instances, with no execution queue.
 * Unresolved reservations are deliberately not reclaimed on a timer: a lost
 * acknowledgement can mean a Git operation ran. Trusted reconciliation is required.
 */
export async function reserveGitOperation(input: ReserveGitOperationInput): Promise<void> {
  if (!input || typeof input !== "object") conflict();
  requireId(input.id);
  requireId(input.executionId);
  if (!validIdentity(input.projectId) || !validIdentity(input.workspaceId) ||
      typeof input.actorId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.actorId) ||
      !isGitMutation(input.operationKey) ||
      typeof input.repositoryKey !== "string" || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(input.repositoryKey) ||
      Buffer.byteLength(input.repositoryKey, "utf8") > 256 || typeof input.scopeDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.scopeDigest)) conflict();

  await withStoreErrors(() => prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cr8or-git-repository:${input.repositoryKey}`}, 0))::text`;
    // Hash collisions only serialize unrelated workspaces; they cannot bypass
    // exact workspace-ID predicates or the unique unresolved-workspace index.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cr8or-command:${input.workspaceId}`}, 0))::text`;
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"
    `;
    const [commands] = await tx.$queryRaw<Array<{ active: number }>>`
      SELECT count(*)::integer AS "active" FROM "CommandOperation"
      WHERE "workspaceId" = ${input.workspaceId} AND "status" IN ('RESERVED', 'RUNNING', 'UNKNOWN')
    `;
    if (commands.active > 0) conflict();
    const [counts] = await tx.$queryRaw<Array<{ active: number; recent: number }>>`
      SELECT COUNT(*) FILTER (WHERE "status" IN ('RESERVED', 'RUNNING', 'UNKNOWN'))::integer AS "active",
        COUNT(*) FILTER (WHERE "createdAt" > ${new Date(clock.now.getTime() - GIT_WINDOW_MS)})::integer AS "recent"
      FROM "GitOperation" WHERE "workspaceId" = ${input.workspaceId} OR "repositoryKey" = ${input.repositoryKey}
    `;
    if (counts.active >= GIT_MAX_CONCURRENT_PER_WORKSPACE || counts.recent >= GIT_MAX_STARTS_PER_WINDOW) conflict();
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "GitOperation"
        ("id", "projectId", "workspaceId", "repositoryKey", "operationKey", "scopeDigest", "actorId", "executionId", "createdAt", "updatedAt")
      VALUES (${input.id}::uuid, ${input.projectId}, ${input.workspaceId}, ${input.repositoryKey}, ${input.operationKey}, ${input.scopeDigest}, ${input.actorId},
        ${input.executionId}::uuid, ${clock.now}, ${clock.now})
      ON CONFLICT ("id") DO NOTHING RETURNING "id"
    `;
    if (inserted.length !== 1) conflict();
  }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 5_000 }));
}

/** Atomic one-shot claim: no caller may dispatch twice, including after retry. */
export async function markGitDispatched(id: string): Promise<void> {
  requireId(id);
  await withStoreErrors(async () => {
    const count = await prisma.$executeRaw`
      UPDATE "GitOperation"
      SET "status" = 'RUNNING', "startedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
          "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
      WHERE "id" = ${id}::uuid AND "status" = 'RESERVED'
    `;
    if (count !== 1) conflict();
  });
}

/**
 * A completed provider request or deleted shell session is not evidence that a
 * process stopped. Callers use UNKNOWN for every ambiguous remote outcome.
 * UNKNOWN retains the workspace slot and cannot be cleared through this API.
 */
export async function finishGitOperation(id: string, input: FinishGitOperationInput): Promise<void> {
  requireId(id);
  if (!input || typeof input !== "object") conflict();
  if (!["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"].includes(input.status) ||
      (input.exitCode !== undefined && (!Number.isInteger(input.exitCode) || input.exitCode < -2_147_483_648 || input.exitCode > 2_147_483_647)) ||
      (input.cancellationConfirmed !== undefined && typeof input.cancellationConfirmed !== "boolean") ||
      (input.cleanupConfirmed !== undefined && typeof input.cleanupConfirmed !== "boolean") ||
      (input.status === "SUCCEEDED" && input.exitCode !== 0)) conflict();
  await withStoreErrors(() => prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<GitOperation[]>`
      SELECT * FROM "GitOperation" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    const current = rows[0];
    if (!current) conflict();
    const exitCode = input.exitCode ?? null;
    const cancellationConfirmed = input.cancellationConfirmed ?? false;
    const cleanupConfirmed = input.cleanupConfirmed ?? false;
    if (!["RESERVED", "RUNNING"].includes(current.status)) {
      if (current.status === input.status && current.exitCode === exitCode &&
          current.cancellationConfirmed === cancellationConfirmed && current.cleanupConfirmed === cleanupConfirmed) return;
      conflict();
    }
    if (input.status === "SUCCEEDED" && current.status !== "RUNNING") conflict();
    if (current.status === "RUNNING" && input.status !== "UNKNOWN") {
      // A timeout, disconnect, or provider error without positive process-end
      // evidence must never silently release a distributed concurrency slot.
      // Even exit code zero proves only the direct Git operation's completion. The
      // dispatcher must also confirm that descendants stopped and session
      // cleanup completed before this shared workspace reservation is freed.
      if (!cancellationConfirmed || !cleanupConfirmed) conflict();
    }
    await tx.$executeRaw`
      UPDATE "GitOperation" SET "status" = ${input.status}::"CommandOperationStatus",
        "exitCode" = ${exitCode}, "cancellationConfirmed" = ${cancellationConfirmed}, "cleanupConfirmed" = ${cleanupConfirmed},
        "completedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
        "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
      WHERE "id" = ${id}::uuid
    `;
  }, { maxWait: 5_000, timeout: 5_000 }));
}

/** Internal metadata only; a returned record does not authorize any operation. */
export async function readGitOperation(id: string): Promise<GitOperation | null> {
  requireId(id);
  return withStoreErrors(async () => {
    const rows = await prisma.$queryRaw<GitOperation[]>`SELECT * FROM "GitOperation" WHERE "id" = ${id}::uuid`;
    return rows[0] ?? null;
  });
}

/** Never deletes unresolved/UNKNOWN records or records inside the rate window. */
export async function cleanupCompletedGitOperations(retentionDays = 30): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) conflict();
  return withStoreErrors(() => prisma.$executeRaw`
    DELETE FROM "GitOperation" WHERE "status" IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED')
      AND "completedAt" < (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - ${retentionDays} * INTERVAL '1 day'
  `);
}
