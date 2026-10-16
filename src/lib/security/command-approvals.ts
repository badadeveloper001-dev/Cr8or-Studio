import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { resolvePrivateOwnerBinding, type AuthSession } from "@/lib/security/auth";
import { findDevelopmentCommand } from "@/lib/security/command-catalogue";
import {
  ExecutionAuthorizationError,
  resolveExecutionSessionBinding,
  type ExecutionAuthorizationContext,
} from "@/lib/security/execution-context";

export const PRIVATE_COMMAND_APPROVAL_TTL_MS = 10 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSACTION_OPTIONS = { isolationLevel: "ReadCommitted" as const, maxWait: 5_000, timeout: 5_000 };
type Binding = NonNullable<Awaited<ReturnType<typeof resolvePrivateOwnerBinding>>>;
type Tx = Prisma.TransactionClient;
type ApprovalState = "PENDING" | "APPROVED" | "DENIED" | "REVOKED";
type ApprovalRow = {
  id: string; ownerId: string; sessionId: string; credentialVersion: number;
  projectId: string; workspaceRecordId: string; providerWorkspaceId: string; commandKey: string;
  status: ApprovalState; createdAt: Date; expiresAt: Date; decidedAt: Date | null;
  revokedAt: Date | null; consumedAt: Date | null; consumedOperationId: string | null; consumedActorId: string | null;
};
type RegisteredWorkspace = {
  id: string; projectId: string; runtimeType: string; provider: string | null;
  providerWorkspaceId: string | null; repositoryUrl: string | null; branch: string | null;
};

/** Safe review DTO: session identity/generation never leave this server module. */
export type CommandApprovalView = {
  id: string;
  action: "commands.execute";
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
  scope: { ownerId: "owner"; projectId: string; providerWorkspaceId: string; commandKey: string };
};

function conflict(): never {
  throw new ExecutionAuthorizationError(409, "Command approval is not valid for this operation.");
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
    throw new ExecutionAuthorizationError(503, "Command approval storage is unavailable.");
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
  const projects = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR SHARE
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
  return count.count === 1 ? row : null;
}
function contextMatches(context: ExecutionAuthorizationContext, row: RegisteredWorkspace | null): row is RegisteredWorkspace {
  return row !== null && context.projectId === row.projectId && context.workspace.id === row.id &&
    context.workspace.runtimeType === "cloud" && context.workspace.provider === "daytona" &&
    context.workspace.providerWorkspaceId === row.providerWorkspaceId &&
    context.workspace.repositoryUrl === row.repositoryUrl && context.workspace.branch === row.branch;
}
function scopeMatches(row: ApprovalRow, binding: Binding, workspace: RegisteredWorkspace | null, commandKey = row.commandKey): boolean {
  return workspace !== null && row.ownerId === "owner" && row.sessionId === binding.sessionId &&
    row.credentialVersion === binding.credentialVersion && row.projectId === workspace.projectId &&
    row.workspaceRecordId === workspace.id && row.providerWorkspaceId === workspace.providerWorkspaceId &&
    row.commandKey === commandKey && !!findDevelopmentCommand(row.commandKey);
}
function view(row: ApprovalRow, now: Date, validScope = true): CommandApprovalView {
  const scope: CommandApprovalView["scope"] = { ownerId: "owner", projectId: row.projectId,
    providerWorkspaceId: row.providerWorkspaceId, commandKey: row.commandKey };
  const status = row.status === "REVOKED" ? "revoked" : row.status === "DENIED" ? "denied" :
    !validScope ? "invalidated" : row.consumedAt ? "consumed" : row.expiresAt <= now ? "expired" :
      row.status === "APPROVED" ? "approved" : "pending";
  return { id: row.id, action: "commands.execute", title: `Execute ${row.commandKey}`,
    preview: JSON.stringify(scope, null, 2), requestedBy: "owner", requestedRole: "owner",
    requestedAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), status,
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString(), decidedBy: "owner" as const } : {}),
    ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}), scope };
}
async function readApproval(tx: Tx, id: string, forUpdate = false): Promise<ApprovalRow | null> {
  const rows = forUpdate ? await tx.$queryRaw<ApprovalRow[]>`
    SELECT * FROM "CommandApproval" WHERE "id" = ${id}::uuid FOR UPDATE
  ` : await tx.$queryRaw<ApprovalRow[]>`SELECT * FROM "CommandApproval" WHERE "id" = ${id}::uuid`;
  return rows[0] ?? null;
}

/** Only a genuine server-minted execution capability can establish scope. */
export async function createPrivateCommandApproval(context: ExecutionAuthorizationContext, commandKey: string): Promise<CommandApprovalView> {
  return safe(async () => {
    const binding = await resolveExecutionSessionBinding(context);
    if (!findDevelopmentCommand(commandKey) || !context.permissions.includes("command")) {
      throw new ExecutionAuthorizationError(403);
    }
    return prisma.$transaction(async (tx) => {
      const sessionExpiresAt = await lockSession(tx, binding);
      const workspace = await lockWorkspace(tx, context.projectId);
      if (!contextMatches(context, workspace)) conflict();
      const now = await clock(tx);
      if (sessionExpiresAt <= now || context.signal.aborted) throw new ExecutionAuthorizationError(401);
      const expiresAt = new Date(Math.min(now.getTime() + PRIVATE_COMMAND_APPROVAL_TTL_MS, sessionExpiresAt.getTime()));
      const [row] = await tx.$queryRaw<ApprovalRow[]>`
        INSERT INTO "CommandApproval" ("id", "ownerId", "sessionId", "credentialVersion", "projectId",
          "workspaceRecordId", "providerWorkspaceId", "commandKey", "createdAt", "expiresAt")
        VALUES (${randomUUID()}::uuid, 'owner', ${binding.sessionId}, ${binding.credentialVersion}, ${workspace.projectId},
          ${workspace.id}, ${workspace.providerWorkspaceId}, ${commandKey}, ${now}, ${expiresAt}) RETURNING *
      `;
      return view(row, now);
    }, TRANSACTION_OPTIONS);
  });
}

/** Decisions are immutable except explicit revocation, including consumed grants. */
export async function decidePrivateCommandApproval(session: AuthSession, id: string,
  decision: "approved" | "denied" | "revoked"): Promise<CommandApprovalView | null> {
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
        UPDATE "CommandApproval" SET "status" = 'REVOKED', "decidedAt" = COALESCE("decidedAt", ${now}),
          "revokedAt" = ${now} WHERE "id" = ${id}::uuid RETURNING *
      ` : await tx.$queryRaw<ApprovalRow[]>`
        UPDATE "CommandApproval" SET "status" = ${decision.toUpperCase()}::"CommandApprovalStatus", "decidedAt" = ${now}
        WHERE "id" = ${id}::uuid RETURNING *
      `;
      return view(updated, now);
    }, TRANSACTION_OPTIONS);
  });
}

/** Only this authenticated device's approvals are returned; no session DTO leaks. */
export async function listPrivateCommandApprovals(session: AuthSession, limit = 100): Promise<CommandApprovalView[]> {
  return safe(async () => {
    const binding = await requireSession(session);
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    return prisma.$transaction(async (tx) => {
      const sessionExpiresAt = await lockSession(tx, binding);
      const rows = await tx.$queryRaw<Array<ApprovalRow & { scopeValid: boolean }>>`
        SELECT a.*, EXISTS (
          SELECT 1 FROM "Project" p JOIN "Workspace" w ON w."projectId" = p."id"
          WHERE p."id" = a."projectId" AND w."id" = a."workspaceRecordId"
            AND w."runtimeType" = 'cloud' AND w."provider" = 'daytona'
            AND w."providerWorkspaceId" = a."providerWorkspaceId"
            AND (SELECT count(*) FROM "Workspace" x WHERE x."provider" = 'daytona'
              AND x."providerWorkspaceId" = a."providerWorkspaceId") = 1
        ) AS "scopeValid" FROM "CommandApproval" a
        WHERE a."ownerId" = 'owner' AND a."sessionId" = ${binding.sessionId}
        ORDER BY a."createdAt" DESC, a."id" DESC LIMIT ${count}
      `;
      const now = await clock(tx);
      if (sessionExpiresAt <= now) throw new ExecutionAuthorizationError(401);
      return rows.map((row) => view(row, now, row.scopeValid && row.credentialVersion === binding.credentialVersion));
    }, TRANSACTION_OPTIONS);
  });
}

async function validateReceiptOrConsume(context: ExecutionAuthorizationContext, commandKey: string, approvalId: string,
  operationId: string, actorId: string, consume: boolean): Promise<boolean> {
  return safe(async () => {
    const binding = await resolveExecutionSessionBinding(context);
    if (!uuid(approvalId) || !uuid(operationId) || !findDevelopmentCommand(commandKey) ||
        typeof actorId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(actorId) || !context.permissions.includes("command")) return false;
    return prisma.$transaction(async (tx) => {
      const sessionExpiresAt = await lockSession(tx, binding);
      const workspace = await lockWorkspace(tx, context.projectId);
      if (!contextMatches(context, workspace)) return false;
      if (consume) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cr8or-command-approval:${operationId}`}, 0))::text`;
        const receipts = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "CommandApproval" WHERE "consumedOperationId" = ${operationId}::uuid
        `;
        if (receipts.length !== 0) return false;
      }
      const row = await readApproval(tx, approvalId, true);
      const now = await clock(tx);
      if (sessionExpiresAt <= now || context.signal.aborted) throw new ExecutionAuthorizationError(401);
      if (!row || !scopeMatches(row, binding, workspace, commandKey) || row.status !== "APPROVED" ||
          row.revokedAt || row.expiresAt <= now) return false;
      if (!consume) return !!row.consumedAt && row.consumedOperationId === operationId && row.consumedActorId === actorId;
      if (row.consumedAt) return false;
      // The row lock serializes contenders across application instances. The
      // predicates remain explicit and the unique operation receipt prevents
      // reusing one operation ID to consume another approval.
      const updated = await tx.$executeRaw`
        UPDATE "CommandApproval" SET "consumedAt" = ${now}, "consumedOperationId" = ${operationId}::uuid,
          "consumedActorId" = ${actorId}
        WHERE "id" = ${approvalId}::uuid AND "status" = 'APPROVED' AND "consumedAt" IS NULL
      `;
      return updated === 1;
    }, TRANSACTION_OPTIONS);
  });
}

/** A legacy action-only approval has no row here and cannot be upgraded. */
export async function consumePrivateCommandApproval(context: ExecutionAuthorizationContext, commandKey: string,
  approvalId: string, operationId: string, actorId: string): Promise<boolean> {
  return validateReceiptOrConsume(context, commandKey, approvalId, operationId, actorId, true);
}

/** Rechecking a consumed receipt never consumes a second approval or authorizes a different operation. */
export async function validateConsumedPrivateCommandApproval(context: ExecutionAuthorizationContext, commandKey: string,
  approvalId: string, operationId: string, actorId: string): Promise<boolean> {
  return validateReceiptOrConsume(context, commandKey, approvalId, operationId, actorId, false);
}
