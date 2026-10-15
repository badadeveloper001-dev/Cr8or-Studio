import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { AuthMethod, AuthSession, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

const OWNER_ID = "owner";
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const sessionSelect = {
  id: true,
  ownerId: true,
  credentialVersion: true,
  authenticationMethod: true,
  authenticatedAt: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  lastActiveAt: true,
} satisfies Prisma.AuthSessionSelect;

export type OwnerSession = Omit<AuthSession, "tokenHash">;

type SessionStoreErrorCode = "UNAVAILABLE" | "OWNER_NOT_PROVISIONED" | "CREDENTIAL_VERSION_CHANGED" | "INVALID_EXPIRATION";

/** Safe to report without exposing database errors, credentials, or query parameters. */
export class SessionStoreError extends Error {
  constructor(readonly code: SessionStoreErrorCode = "UNAVAILABLE") {
    super({
      UNAVAILABLE: "Session storage is unavailable.",
      OWNER_NOT_PROVISIONED: "The owner credential has not been provisioned.",
      CREDENTIAL_VERSION_CHANGED: "The owner credential version has changed. Authenticate again.",
      INVALID_EXPIRATION: "Session expiration must be in the future.",
    }[code]);
    this.name = "SessionStoreError";
  }
}

async function withStoreErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    // Do not attach a Prisma error: it may contain connection details or query inputs.
    throw new SessionStoreError();
  }
}

/** SHA-256 is for random session tokens only, never access-code/password hashing. */
export function hashSessionToken(token: string): string {
  if (typeof token !== "string" || token.length !== 43 || !TOKEN_PATTERN.test(token) ||
      Buffer.from(token, "base64url").toString("base64url") !== token) {
    throw new TypeError("Invalid session token format.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

type CreateOwnerSessionInput = {
  /** The exact version whose credential was successfully verified by the caller. */
  credentialVersion: number;
  authenticationMethod: AuthMethod;
  expiresAt: Date;
};

/**
 * Persistence only: the caller must verify a credential before invoking this.
 * The raw token is returned once for a future HTTP layer, and is never persisted.
 */
export async function createOwnerSession(input: CreateOwnerSessionInput): Promise<{
  token: string;
  session: OwnerSession;
}> {
  if (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion < 1 ||
      input.credentialVersion > 2_147_483_647 ||
      !["ACCESS_CODE", "PASSKEY"].includes(input.authenticationMethod) ||
      !(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) {
    throw new TypeError("Invalid session creation input.");
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const session = await withStoreErrors(() => prisma.$transaction(async (tx) => {
    // Credential updates and revoke-all serialize on this same owner row.
    const owners = await tx.$queryRaw<Array<{ credentialVersion: number }>>`
      SELECT "credentialVersion" FROM "OwnerCredential"
      WHERE "id" = ${OWNER_ID} FOR UPDATE
    `;
    if (!owners[0]) throw new SessionStoreError("OWNER_NOT_PROVISIONED");
    if (owners[0].credentialVersion !== input.credentialVersion) {
      throw new SessionStoreError("CREDENTIAL_VERSION_CHANGED");
    }
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"
    `;
    if (input.expiresAt <= clock.now) {
      throw new SessionStoreError("INVALID_EXPIRATION");
    }
    return tx.authSession.create({
      data: {
        ownerId: OWNER_ID,
        tokenHash,
        credentialVersion: input.credentialVersion,
        authenticationMethod: input.authenticationMethod,
        authenticatedAt: clock.now,
        createdAt: clock.now,
        expiresAt: input.expiresAt,
      },
      select: sessionSelect,
    });
  }));
  return { token, session };
}

/** Validate using one database snapshot, without cross-request authorization caching. */
export async function resolveSessionByTokenHash(tokenHash: string): Promise<OwnerSession | null> {
  if (typeof tokenHash !== "string" || tokenHash.length !== 64 || !DIGEST_PATTERN.test(tokenHash)) return null;
  return withStoreErrors(async () => {
    const sessions = await prisma.$queryRaw<OwnerSession[]>`
      SELECT s."id", s."ownerId", s."credentialVersion", s."authenticationMethod",
             s."authenticatedAt", s."createdAt", s."expiresAt", s."revokedAt", s."lastActiveAt"
      FROM "AuthSession" s
      INNER JOIN "OwnerCredential" o ON o."id" = s."ownerId"
        AND o."credentialVersion" = s."credentialVersion"
      WHERE s."tokenHash" = ${tokenHash} AND s."ownerId" = ${OWNER_ID}
        AND s."revokedAt" IS NULL
        AND s."expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
      LIMIT 1
    `;
    return sessions[0] ?? null;
  });
}

export async function resolveOwnerSession(token: string): Promise<OwnerSession | null> {
  let digest: string;
  try {
    digest = hashSessionToken(token);
  } catch {
    return null;
  }
  return resolveSessionByTokenHash(digest);
}

export async function revokeSession(sessionId: string): Promise<number> {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
    throw new TypeError("Invalid session identifier.");
  }
  return withStoreErrors(() => prisma.$executeRaw`
    UPDATE "AuthSession" SET "revokedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
    WHERE "id" = ${sessionId} AND "ownerId" = ${OWNER_ID} AND "revokedAt" IS NULL
  `);
}

/** Increments the credential generation so an in-flight old verification cannot reopen a session. */
export async function revokeAllOwnerSessions(): Promise<{ revokedCount: number; credentialVersion: number }> {
  return withStoreErrors(() => prisma.$transaction(async (tx) => {
    const owners = await tx.$queryRaw<Array<{ credentialVersion: number }>>`
      UPDATE "OwnerCredential"
      SET "credentialVersion" = "credentialVersion" + 1,
          "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
      WHERE "id" = ${OWNER_ID} RETURNING "credentialVersion"
    `;
    if (!owners[0]) throw new SessionStoreError("OWNER_NOT_PROVISIONED");
    const revokedCount = await tx.$executeRaw`
      UPDATE "AuthSession" SET "revokedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
      WHERE "ownerId" = ${OWNER_ID} AND "revokedAt" IS NULL
    `;
    return { revokedCount, credentialVersion: owners[0].credentialVersion };
  }));
}

export async function cleanupExpiredSessions(): Promise<number> {
  return withStoreErrors(() => prisma.$executeRaw`
    DELETE FROM "AuthSession"
    WHERE "expiresAt" <= (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
  `);
}
