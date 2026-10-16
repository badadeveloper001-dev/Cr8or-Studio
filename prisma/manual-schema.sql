-- Manual bootstrap snapshot for an EMPTY database only.
-- Prefer `npm run db:migrate` to apply the versioned Prisma migrations.
-- Do not run this snapshot against an existing database or use it as an
-- incremental migration. Existing deployments must run `npm run db:migrate`
-- explicitly before deploying code that requires new tables.
-- Manual bootstrap does not record Prisma migration history; establish the
-- appropriate migration baseline before subsequently using Prisma Migrate.
-- This snapshot creates no owner credential and activates no authentication.

CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "framework" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "repository" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "output" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GlobalMemory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LocalAgentMemory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalAgentMemory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Task"
ADD CONSTRAINT "Task_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GlobalMemory"
ADD CONSTRAINT "GlobalMemory_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LocalAgentMemory"
ADD CONSTRAINT "LocalAgentMemory_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeType" TEXT NOT NULL,
    "provider" TEXT,
    "providerWorkspaceId" TEXT,
    "repositoryUrl" TEXT,
    "projectName" TEXT,
    "branch" TEXT,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Workspace_projectId_key" ON "Workspace"("projectId");

ALTER TABLE "Workspace"
ADD CONSTRAINT "Workspace_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Additive authentication foundation only. Existing project, workspace, task,
-- and memory tables are unchanged. No owner credential is provisioned here.

CREATE TYPE "AuthMethod" AS ENUM ('ACCESS_CODE', 'PASSKEY');
CREATE TYPE "AuthRateLimitScope" AS ENUM ('SOURCE', 'GLOBAL');

CREATE TABLE "OwnerCredential" (
    "id" TEXT NOT NULL DEFAULT 'owner',
    "accessCodeHash" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "webAuthnUserHandle" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerCredential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OwnerCredential_singleton_check" CHECK ("id" = 'owner'),
    CONSTRAINT "OwnerCredential_version_check" CHECK ("credentialVersion" > 0),
    CONSTRAINT "OwnerCredential_user_handle_check" CHECK (octet_length("webAuthnUserHandle") = 32)
);

CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "authenticationMethod" "AuthMethod" NOT NULL,
    "authenticatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuthSession_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AuthSession_version_check" CHECK ("credentialVersion" > 0),
    CONSTRAINT "AuthSession_expiry_check" CHECK ("expiresAt" > "authenticatedAt" AND "expiresAt" > "createdAt")
);

CREATE TABLE "AuthRateLimit" (
    "scope" "AuthRateLimitScope" NOT NULL,
    "keyHash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "windowExpiresAt" TIMESTAMP(3) NOT NULL,
    "cooldownUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("scope", "keyHash"),
    CONSTRAINT "AuthRateLimit_key_hash_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AuthRateLimit_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "AuthRateLimit_window_check" CHECK ("windowExpiresAt" > "windowStartedAt"),
    CONSTRAINT "AuthRateLimit_expiry_check" CHECK (
        "expiresAt" >= "windowExpiresAt"
        AND ("cooldownUntil" IS NULL OR "expiresAt" >= "cooldownUntil")
    )
);

CREATE UNIQUE INDEX "OwnerCredential_webAuthnUserHandle_key" ON "OwnerCredential"("webAuthnUserHandle");
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");
CREATE INDEX "AuthSession_ownerId_revokedAt_idx" ON "AuthSession"("ownerId", "revokedAt");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
CREATE INDEX "AuthRateLimit_expiresAt_idx" ON "AuthRateLimit"("expiresAt");

ALTER TABLE "AuthSession"
ADD CONSTRAINT "AuthSession_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "OwnerCredential"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Deny browser-facing roles even if hosting-platform defaults grant table
-- privileges. No public policies are created. The trusted server must use the
-- table owner or an explicitly authorized BYPASSRLS role with table privileges.
-- RLS is intentionally not forced, so the table owner can manage authentication.
ALTER TABLE "OwnerCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthRateLimit" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "OwnerCredential", "AuthSession", "AuthRateLimit" FROM PUBLIC;

-- Command operation metadata follows the same private-table access restrictions.
-- Additive private command coordination. No existing records or identifiers change.
-- Execute explicitly before a deployment requiring this table. This migration
-- neither enables command execution nor provisions authentication.

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
