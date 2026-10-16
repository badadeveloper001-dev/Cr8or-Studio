import "server-only";

import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/db/prisma";
import { hashAccessCode } from "@/lib/security/access-code";

export { revokeAllOwnerSessions } from "@/lib/security/session-store";

const OWNER_ID = "owner";

type OwnerManagementErrorCode = "UNAVAILABLE" | "ALREADY_PROVISIONED" | "OWNER_NOT_PROVISIONED";

/** Contains only fixed, operator-safe messages; never wraps database error details. */
export class OwnerManagementError extends Error {
  constructor(readonly code: OwnerManagementErrorCode = "UNAVAILABLE") {
    super({
      UNAVAILABLE: "Owner credential storage is unavailable.",
      ALREADY_PROVISIONED: "The owner is already provisioned. Use rotation to change the access code.",
      OWNER_NOT_PROVISIONED: "The owner credential has not been provisioned.",
    }[code]);
    this.name = "OwnerManagementError";
  }
}

async function withStoreErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OwnerManagementError) throw error;
    throw new OwnerManagementError();
  }
}

export type OwnerCredentialMetadata = {
  credentialVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Operator-only bootstrap. The unique singleton ID also serializes concurrent attempts. */
export async function provisionOwner(accessCode: string): Promise<OwnerCredentialMetadata> {
  // Expensive hashing never holds a database connection or row lock.
  const accessCodeHash = await hashAccessCode(accessCode);
  const webAuthnUserHandle = randomBytes(32);
  return withStoreErrors(async () => {
    const owners = await prisma.$queryRaw<OwnerCredentialMetadata[]>`
      INSERT INTO "OwnerCredential"
        ("id", "accessCodeHash", "credentialVersion", "webAuthnUserHandle", "createdAt", "updatedAt")
      VALUES (${OWNER_ID}, ${accessCodeHash}, 1, ${webAuthnUserHandle},
        (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
        (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
      ON CONFLICT ("id") DO NOTHING
      RETURNING "credentialVersion", "createdAt", "updatedAt"
    `;
    if (!owners[0]) throw new OwnerManagementError("ALREADY_PROVISIONED");
    return owners[0];
  });
}

/** Updates the hash and generation, then revokes all sessions under the same owner-row lock. */
export async function rotateOwnerAccessCode(accessCode: string): Promise<OwnerCredentialMetadata & {
  revokedCount: number;
}> {
  const accessCodeHash = await hashAccessCode(accessCode);
  return withStoreErrors(() => prisma.$transaction(async (tx) => {
    // This UPDATE takes the lock used by session creation and revoke-all. The stable
    // WebAuthn user handle is deliberately absent from the update.
    const owners = await tx.$queryRaw<OwnerCredentialMetadata[]>`
      UPDATE "OwnerCredential"
      SET "accessCodeHash" = ${accessCodeHash},
          "credentialVersion" = "credentialVersion" + 1,
          "updatedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
      WHERE "id" = ${OWNER_ID}
      RETURNING "credentialVersion", "createdAt", "updatedAt"
    `;
    if (!owners[0]) throw new OwnerManagementError("OWNER_NOT_PROVISIONED");
    const revokedCount = await tx.$executeRaw`
      UPDATE "AuthSession" SET "revokedAt" = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
      WHERE "ownerId" = ${OWNER_ID} AND "revokedAt" IS NULL
    `;
    return { ...owners[0], revokedCount };
  }));
}

export type OwnerStatus = {
  provisioned: boolean;
  credentialVersion: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  sessions: { total: number; active: number; revoked: number; expired: number };
};

/** One snapshot, explicit columns, and aggregate counts only. Expired and revoked may overlap. */
export async function inspectOwnerStatus(): Promise<OwnerStatus> {
  return withStoreErrors(async () => {
    const owners = await prisma.$queryRaw<Array<OwnerCredentialMetadata & {
      total: number; active: number; revoked: number; expired: number;
    }>>`
      SELECT o."credentialVersion", o."createdAt", o."updatedAt",
        COUNT(s."id")::integer AS "total",
        COUNT(s."id") FILTER (WHERE s."revokedAt" IS NULL
          AND s."credentialVersion" = o."credentialVersion"
          AND s."expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3))::integer AS "active",
        COUNT(s."id") FILTER (WHERE s."revokedAt" IS NOT NULL)::integer AS "revoked",
        COUNT(s."id") FILTER (WHERE s."expiresAt" <=
          (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3))::integer AS "expired"
      FROM "OwnerCredential" o
      LEFT JOIN "AuthSession" s ON s."ownerId" = o."id"
      WHERE o."id" = ${OWNER_ID}
      GROUP BY o."id"
    `;
    const owner = owners[0];
    if (!owner) return {
      provisioned: false, credentialVersion: null, createdAt: null, updatedAt: null,
      sessions: { total: 0, active: 0, revoked: 0, expired: 0 },
    };
    return {
      provisioned: true, credentialVersion: owner.credentialVersion,
      createdAt: owner.createdAt, updatedAt: owner.updatedAt,
      sessions: { total: owner.total, active: owner.active, revoked: owner.revoked, expired: owner.expired },
    };
  });
}
