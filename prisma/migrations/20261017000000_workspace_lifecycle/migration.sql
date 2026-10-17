-- Additive lifecycle coordination only. No historical project, workspace,
-- provider identity, repository, task, memory, or credential is modified.
BEGIN;
CREATE TYPE "WorkspaceLifecycleStatus" AS ENUM ('RESERVED', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN');

CREATE TABLE "WorkspaceLifecycleApproval" (
  "id" UUID NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL DEFAULT 'owner',
  "sessionId" VARCHAR(128) NOT NULL,
  "credentialVersion" INTEGER NOT NULL,
  "projectId" VARCHAR(256) NOT NULL,
  "workspaceRecordId" VARCHAR(256) NOT NULL,
  "providerWorkspaceId" VARCHAR(256),
  "action" VARCHAR(16) NOT NULL,
  "scope" JSONB NOT NULL,
  "scopeDigest" CHAR(64) NOT NULL,
  "status" "CommandApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "consumedOperationId" UUID,
  CONSTRAINT "WorkspaceLifecycleApproval_identity_check" CHECK (
    "ownerId" = 'owner' AND "credentialVersion" > 0
    AND octet_length("sessionId") BETWEEN 1 AND 128
    AND octet_length("projectId") BETWEEN 1 AND 256
    AND octet_length("workspaceRecordId") BETWEEN 1 AND 256
    AND ("providerWorkspaceId" IS NULL OR octet_length("providerWorkspaceId") BETWEEN 1 AND 256)
  ),
  CONSTRAINT "WorkspaceLifecycleApproval_scope_check" CHECK (
    "action" IN ('create', 'clone', 'start', 'stop')
    AND "scopeDigest" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("scope") = 'object' AND octet_length("scope"::text) <= 8192
  ),
  CONSTRAINT "WorkspaceLifecycleApproval_expiration_check" CHECK (
    "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'
  ),
  CONSTRAINT "WorkspaceLifecycleApproval_decision_check" CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" IN ('APPROVED', 'DENIED') AND "decidedAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "decidedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
  ),
  CONSTRAINT "WorkspaceLifecycleApproval_consumption_check" CHECK (
    ("consumedAt" IS NULL AND "consumedOperationId" IS NULL)
    OR ("consumedAt" IS NOT NULL AND "consumedOperationId" IS NOT NULL
      AND "status" IN ('APPROVED', 'REVOKED') AND "consumedAt" >= "decidedAt" AND "consumedAt" < "expiresAt")
  ),
  CONSTRAINT "WorkspaceLifecycleApproval_timestamps_check" CHECK (
    ("decidedAt" IS NULL OR "decidedAt" >= "createdAt")
    AND ("revokedAt" IS NULL OR "revokedAt" >= "decidedAt")
  )
);
CREATE UNIQUE INDEX "WorkspaceLifecycleApproval_consumedOperationId_key" ON "WorkspaceLifecycleApproval"("consumedOperationId");
CREATE INDEX "WorkspaceLifecycleApproval_sessionId_createdAt_idx" ON "WorkspaceLifecycleApproval"("sessionId", "createdAt");
CREATE INDEX "WorkspaceLifecycleApproval_expiresAt_idx" ON "WorkspaceLifecycleApproval"("expiresAt");

CREATE TABLE "WorkspaceLifecycleOperation" (
  "id" UUID NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL DEFAULT 'owner',
  "sessionId" VARCHAR(128) NOT NULL,
  "credentialVersion" INTEGER NOT NULL,
  "projectId" VARCHAR(256) NOT NULL,
  "workspaceRecordId" VARCHAR(256) NOT NULL,
  "providerWorkspaceId" VARCHAR(256),
  "providerResourceId" VARCHAR(256),
  "action" VARCHAR(16) NOT NULL,
  "scope" JSONB NOT NULL,
  "scopeDigest" CHAR(64) NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "approvalId" UUID,
  "status" "WorkspaceLifecycleStatus" NOT NULL DEFAULT 'RESERVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "reconciledAt" TIMESTAMP(3),
  "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastReconciliationAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceLifecycleOperation_identity_check" CHECK (
    "ownerId" = 'owner' AND "credentialVersion" > 0
    AND octet_length("sessionId") BETWEEN 1 AND 128
    AND octet_length("projectId") BETWEEN 1 AND 256
    AND octet_length("workspaceRecordId") BETWEEN 1 AND 256
    AND ("providerWorkspaceId" IS NULL OR octet_length("providerWorkspaceId") BETWEEN 1 AND 256)
    AND ("providerResourceId" IS NULL OR octet_length("providerResourceId") BETWEEN 1 AND 256)
    AND ("providerWorkspaceId" IS NULL OR "providerResourceId" IS NULL OR "providerWorkspaceId" = "providerResourceId")
  ),
  CONSTRAINT "WorkspaceLifecycleOperation_scope_check" CHECK (
    "action" IN ('create', 'clone', 'start', 'stop')
    AND "scopeDigest" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("scope") = 'object' AND octet_length("scope"::text) <= 8192
  ),
  CONSTRAINT "WorkspaceLifecycleOperation_lifecycle_check" CHECK (
    ("status" = 'RESERVED' AND "attempts" = 0 AND "dispatchedAt" IS NULL AND "completedAt" IS NULL)
    OR ("status" = 'DISPATCHED' AND "attempts" = 1 AND "dispatchedAt" IS NOT NULL AND "completedAt" IS NULL)
    OR ("status" IN ('FAILED', 'CANCELLED') AND "attempts" = 0 AND "dispatchedAt" IS NULL AND "completedAt" IS NOT NULL)
    OR ("status" IN ('SUCCEEDED', 'UNKNOWN') AND "attempts" = 1 AND "dispatchedAt" IS NOT NULL AND "completedAt" IS NOT NULL)
  ),
  CONSTRAINT "WorkspaceLifecycleOperation_success_check" CHECK (
    "status" <> 'SUCCEEDED' OR "providerResourceId" IS NOT NULL
  ),
  CONSTRAINT "WorkspaceLifecycleOperation_reconciliation_check" CHECK (
    ("reconciledAt" IS NULL OR ("status" = 'SUCCEEDED' AND "reconciledAt" >= "dispatchedAt"))
    AND "reconciliationAttempts" BETWEEN 0 AND 3
    AND (("reconciliationAttempts" = 0 AND "lastReconciliationAt" IS NULL)
      OR ("reconciliationAttempts" > 0 AND "lastReconciliationAt" IS NOT NULL AND "dispatchedAt" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "WorkspaceLifecycleOperation_sessionId_idempotencyKey_key" ON "WorkspaceLifecycleOperation"("sessionId", "idempotencyKey");
CREATE UNIQUE INDEX "WorkspaceLifecycleOperation_approvalId_key" ON "WorkspaceLifecycleOperation"("approvalId");
CREATE UNIQUE INDEX "WorkspaceLifecycleOperation_unresolved_project_key" ON "WorkspaceLifecycleOperation"("projectId") WHERE "status" IN ('RESERVED', 'DISPATCHED', 'UNKNOWN');
CREATE UNIQUE INDEX "WorkspaceLifecycleOperation_unresolved_workspace_key" ON "WorkspaceLifecycleOperation"("providerWorkspaceId") WHERE "status" IN ('RESERVED', 'DISPATCHED', 'UNKNOWN');
CREATE UNIQUE INDEX "WorkspaceLifecycleOperation_unresolved_resource_key" ON "WorkspaceLifecycleOperation"("providerResourceId") WHERE "status" IN ('RESERVED', 'DISPATCHED', 'UNKNOWN');
CREATE INDEX "WorkspaceLifecycleOperation_projectId_createdAt_idx" ON "WorkspaceLifecycleOperation"("projectId", "createdAt");
CREATE INDEX "WorkspaceLifecycleOperation_providerWorkspaceId_createdAt_idx" ON "WorkspaceLifecycleOperation"("providerWorkspaceId", "createdAt");
CREATE INDEX "WorkspaceLifecycleOperation_createdAt_idx" ON "WorkspaceLifecycleOperation"("createdAt");
ALTER TABLE "WorkspaceLifecycleApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceLifecycleOperation" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "WorkspaceLifecycleApproval", "WorkspaceLifecycleOperation" FROM PUBLIC;
COMMIT;
