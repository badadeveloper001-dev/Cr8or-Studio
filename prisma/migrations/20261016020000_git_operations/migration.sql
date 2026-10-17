-- Additive private Git approvals and mutation coordination. Existing projects,
-- workspace bindings, authentication and command records are unchanged.
-- Apply explicitly with db:migrate before code requiring these tables.
BEGIN;

CREATE TABLE "GitApproval" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL DEFAULT 'owner',
    "sessionId" VARCHAR(128) NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "projectId" VARCHAR(256) NOT NULL,
    "workspaceRecordId" VARCHAR(256) NOT NULL,
    "providerWorkspaceId" VARCHAR(256) NOT NULL,
    "repositoryKey" VARCHAR(256) NOT NULL,
    "operationKey" VARCHAR(64) NOT NULL,
    "scope" JSONB NOT NULL,
    "scopeDigest" CHAR(64) NOT NULL,
    "status" "CommandApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "consumedOperationId" UUID,
    "consumedActorId" VARCHAR(64),

    CONSTRAINT "GitApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitApproval_identity_check" CHECK (
      "ownerId" = 'owner' AND "credentialVersion" > 0
      AND octet_length("sessionId") BETWEEN 1 AND 128
      AND octet_length("projectId") BETWEEN 1 AND 256
      AND octet_length("workspaceRecordId") BETWEEN 1 AND 256
      AND octet_length("providerWorkspaceId") BETWEEN 1 AND 256
    ),
    CONSTRAINT "GitApproval_scope_check" CHECK (
      "repositoryKey" ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
      AND octet_length("repositoryKey") BETWEEN 3 AND 256
      AND "operationKey" IN ('stage', 'unstage', 'commit', 'push', 'create-branch', 'create-pr', 'upsert-file')
      AND "scopeDigest" ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof("scope") = 'object' AND octet_length("scope"::text) <= 32768
    ),
    CONSTRAINT "GitApproval_expiration_check" CHECK (
      "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'
    ),
    CONSTRAINT "GitApproval_decision_check" CHECK (
      ("status" = 'PENDING' AND "decidedAt" IS NULL AND "revokedAt" IS NULL)
      OR ("status" IN ('APPROVED', 'DENIED') AND "decidedAt" IS NOT NULL AND "revokedAt" IS NULL)
      OR ("status" = 'REVOKED' AND "decidedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    ),
    CONSTRAINT "GitApproval_consumption_check" CHECK (
      ("consumedAt" IS NULL AND "consumedOperationId" IS NULL AND "consumedActorId" IS NULL)
      OR ("consumedAt" IS NOT NULL AND "consumedOperationId" IS NOT NULL AND "consumedActorId" IS NOT NULL
        AND "consumedActorId" ~ '^[A-Za-z0-9_-]{1,64}$'
        AND "status" IN ('APPROVED', 'REVOKED') AND "consumedAt" >= "decidedAt" AND "consumedAt" < "expiresAt")
    ),
    CONSTRAINT "GitApproval_timestamps_check" CHECK (
      ("decidedAt" IS NULL OR "decidedAt" >= "createdAt")
      AND ("revokedAt" IS NULL OR "revokedAt" >= "decidedAt")
    )
);

-- Identity snapshots survive expired-session cleanup and historical project
-- deletion. They never confer authority without checking current registrations.
CREATE UNIQUE INDEX "GitApproval_consumedOperationId_key" ON "GitApproval"("consumedOperationId");
CREATE INDEX "GitApproval_sessionId_createdAt_idx" ON "GitApproval"("sessionId", "createdAt");
CREATE INDEX "GitApproval_expiresAt_idx" ON "GitApproval"("expiresAt");

ALTER TABLE "GitApproval" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "GitApproval" FROM PUBLIC;

CREATE TABLE "GitOperation" (
    "id" UUID NOT NULL,
    "projectId" VARCHAR(256) NOT NULL,
    "workspaceId" VARCHAR(256) NOT NULL,
    "repositoryKey" VARCHAR(256) NOT NULL,
    "operationKey" VARCHAR(64) NOT NULL,
    "scopeDigest" CHAR(64) NOT NULL,
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

    CONSTRAINT "GitOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitOperation_identity_check" CHECK (
      octet_length("projectId") BETWEEN 1 AND 256
      AND octet_length("workspaceId") BETWEEN 1 AND 256
      AND "actorId" ~ '^[A-Za-z0-9_-]{1,64}$'
    ),
    CONSTRAINT "GitOperation_scope_check" CHECK (
      "repositoryKey" ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
      AND octet_length("repositoryKey") BETWEEN 3 AND 256
      AND "operationKey" IN ('stage', 'unstage', 'commit', 'push', 'create-branch', 'create-pr', 'upsert-file')
      AND "scopeDigest" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "GitOperation_lifecycle_check" CHECK (
      ("status" = 'RESERVED' AND "startedAt" IS NULL AND "completedAt" IS NULL AND "exitCode" IS NULL)
      OR ("status" = 'RUNNING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "exitCode" IS NULL)
      OR ("status" NOT IN ('RESERVED', 'RUNNING') AND "completedAt" IS NOT NULL)
    ),
    CONSTRAINT "GitOperation_success_check" CHECK (
      "status" <> 'SUCCEEDED' OR ("startedAt" IS NOT NULL AND "exitCode" IS NOT NULL AND "exitCode" = 0)
    )
);

-- Extra database enforcement in addition to transaction-level advisory locking.
-- Do not add lease expiry to UNKNOWN or infer process termination from age.
CREATE UNIQUE INDEX "GitOperation_unresolved_workspace_key"
ON "GitOperation"("workspaceId") WHERE "status" IN ('RESERVED', 'RUNNING', 'UNKNOWN');
CREATE UNIQUE INDEX "GitOperation_unresolved_repository_key"
ON "GitOperation"("repositoryKey") WHERE "status" IN ('RESERVED', 'RUNNING', 'UNKNOWN');
CREATE INDEX "GitOperation_repositoryKey_createdAt_idx" ON "GitOperation"("repositoryKey", "createdAt");
CREATE INDEX "GitOperation_workspaceId_createdAt_idx" ON "GitOperation"("workspaceId", "createdAt");
CREATE INDEX "GitOperation_completedAt_idx" ON "GitOperation"("completedAt");

ALTER TABLE "GitOperation" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "GitOperation" FROM PUBLIC;

COMMIT;
