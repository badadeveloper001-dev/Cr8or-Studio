-- Additive authentication foundation only. Existing project, workspace, task,
-- and memory tables are unchanged. No owner credential is provisioned here.

BEGIN;

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

COMMIT;
