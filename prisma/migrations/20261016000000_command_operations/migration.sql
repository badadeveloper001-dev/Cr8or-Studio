-- Additive private command coordination. No existing records or identifiers change.
-- Execute explicitly before a deployment requiring this table. This migration
-- neither enables command execution nor provisions authentication.
BEGIN;

CREATE TYPE "CommandOperationStatus" AS ENUM (
  'RESERVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNKNOWN'
);

CREATE TABLE "CommandOperation" (
    "id" UUID NOT NULL,
    "projectId" VARCHAR(256) NOT NULL,
    "workspaceId" VARCHAR(256) NOT NULL,
    "commandKey" VARCHAR(64) NOT NULL,
    "actorId" VARCHAR(64) NOT NULL,
    "executionId" UUID NOT NULL,
    "status" "CommandOperationStatus" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "exitCode" INTEGER,
    "cancellationConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "cleanupConfirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CommandOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommandOperation_identity_check" CHECK (
      octet_length("projectId") BETWEEN 1 AND 256
      AND octet_length("workspaceId") BETWEEN 1 AND 256
      AND "actorId" ~ '^[A-Za-z0-9_-]{1,64}$'
    ),
    CONSTRAINT "CommandOperation_catalogue_check" CHECK ("commandKey" IN (
      'npm run typecheck', 'npm run lint', 'npm test', 'npm run test:unit', 'npm run test:integration'
    )),
    CONSTRAINT "CommandOperation_lifecycle_check" CHECK (
      ("status" = 'RESERVED' AND "startedAt" IS NULL AND "completedAt" IS NULL AND "exitCode" IS NULL)
      OR ("status" = 'RUNNING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "exitCode" IS NULL)
      OR ("status" NOT IN ('RESERVED', 'RUNNING') AND "completedAt" IS NOT NULL)
    ),
    CONSTRAINT "CommandOperation_success_check" CHECK (
      "status" <> 'SUCCEEDED' OR ("startedAt" IS NOT NULL AND "exitCode" IS NOT NULL AND "exitCode" = 0)
    )
);

-- Extra database enforcement in addition to transaction-level advisory locking.
-- Do not add lease expiry to UNKNOWN or infer process termination from age.
CREATE UNIQUE INDEX "CommandOperation_unresolved_workspace_key"
ON "CommandOperation"("workspaceId") WHERE "status" IN ('RESERVED', 'RUNNING', 'UNKNOWN');
CREATE INDEX "CommandOperation_workspaceId_createdAt_idx" ON "CommandOperation"("workspaceId", "createdAt");
CREATE INDEX "CommandOperation_completedAt_idx" ON "CommandOperation"("completedAt");

ALTER TABLE "CommandOperation" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CommandOperation" FROM PUBLIC;

COMMIT;
