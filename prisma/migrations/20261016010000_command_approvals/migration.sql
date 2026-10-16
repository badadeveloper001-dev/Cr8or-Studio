-- Additive operation-scoped private command approvals. No historical project,
-- workspace, credential, or session records change. Apply explicitly before
-- deploying code that uses these tables; execution remains release-restricted.
BEGIN;

CREATE TYPE "CommandApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'REVOKED');

CREATE TABLE "CommandApproval" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL DEFAULT 'owner',
    "sessionId" VARCHAR(128) NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "projectId" VARCHAR(256) NOT NULL,
    "workspaceRecordId" VARCHAR(256) NOT NULL,
    "providerWorkspaceId" VARCHAR(256) NOT NULL,
    "commandKey" VARCHAR(64) NOT NULL,
    "status" "CommandApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "consumedOperationId" UUID,
    "consumedActorId" VARCHAR(64),

    CONSTRAINT "CommandApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommandApproval_identity_check" CHECK (
      "ownerId" = 'owner' AND "credentialVersion" > 0
      AND octet_length("sessionId") BETWEEN 1 AND 128
      AND octet_length("projectId") BETWEEN 1 AND 256
      AND octet_length("workspaceRecordId") BETWEEN 1 AND 256
      AND octet_length("providerWorkspaceId") BETWEEN 1 AND 256
    ),
    CONSTRAINT "CommandApproval_catalogue_check" CHECK ("commandKey" IN (
      'npm run typecheck', 'npm run lint', 'npm test', 'npm run test:unit', 'npm run test:integration'
    )),
    CONSTRAINT "CommandApproval_expiration_check" CHECK (
      "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'
    ),
    CONSTRAINT "CommandApproval_decision_check" CHECK (
      ("status" = 'PENDING' AND "decidedAt" IS NULL AND "revokedAt" IS NULL)
      OR ("status" IN ('APPROVED', 'DENIED') AND "decidedAt" IS NOT NULL AND "revokedAt" IS NULL)
      OR ("status" = 'REVOKED' AND "decidedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    ),
    CONSTRAINT "CommandApproval_consumption_check" CHECK (
      ("consumedAt" IS NULL AND "consumedOperationId" IS NULL AND "consumedActorId" IS NULL)
      OR ("consumedAt" IS NOT NULL AND "consumedOperationId" IS NOT NULL AND "consumedActorId" IS NOT NULL
        AND "consumedActorId" ~ '^[A-Za-z0-9_-]{1,64}$'
        AND "status" IN ('APPROVED', 'REVOKED') AND "consumedAt" >= "decidedAt" AND "consumedAt" < "expiresAt")
    ),
    CONSTRAINT "CommandApproval_timestamps_check" CHECK (
      ("decidedAt" IS NULL OR "decidedAt" >= "createdAt")
      AND ("revokedAt" IS NULL OR "revokedAt" >= "decidedAt")
    )
);

-- Identity snapshots survive expired-session cleanup and historical project
-- deletion. They never confer authority without checking current registrations.
CREATE UNIQUE INDEX "CommandApproval_consumedOperationId_key" ON "CommandApproval"("consumedOperationId");
CREATE INDEX "CommandApproval_sessionId_createdAt_idx" ON "CommandApproval"("sessionId", "createdAt");
CREATE INDEX "CommandApproval_expiresAt_idx" ON "CommandApproval"("expiresAt");

ALTER TABLE "CommandApproval" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CommandApproval" FROM PUBLIC;

COMMIT;
