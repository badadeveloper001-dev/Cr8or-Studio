import "server-only";

import { prisma } from "@/lib/db/prisma";
import {
  AccessCodeFormatError, DUMMY_ACCESS_CODE_HASH, isAccessCodeInput, verifyAccessCode,
} from "@/lib/security/access-code";
import { createOwnerSession } from "@/lib/security/session-store";

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;

export class PrivateAuthBusyError extends Error {
  constructor() {
    super("Authentication verification is busy. Try again shortly.");
    this.name = "PrivateAuthBusyError";
  }
}

/**
 * Rate limiting must run before this service. The PostgreSQL transaction lock
 * admits at most one expensive verification across all application instances.
 * It is released automatically on commit, rollback, or connection loss.
 */
export async function authenticateOwnerAccessCode(accessCode: string) {
  if (!isAccessCodeInput(accessCode)) throw new TypeError("Invalid access-code input.");
  const verified = await prisma.$transaction(async (tx) => {
    const [capacity] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(824101, 1) AS acquired
    `;
    if (!capacity.acquired) throw new PrivateAuthBusyError();

    // Retain the exact generation that was verified. Rotation remains free to
    // update the owner while scrypt runs; session creation checks this generation.
    const owner = await tx.ownerCredential.findUnique({
      where: { id: "owner" },
      select: { accessCodeHash: true, credentialVersion: true },
    });
    let correct: boolean;
    try {
      correct = await verifyAccessCode(accessCode, owner?.accessCodeHash ?? DUMMY_ACCESS_CODE_HASH);
    } catch (error) {
      if (!(error instanceof AccessCodeFormatError)) throw error;
      // A missing or malformed credential must not reveal provisioning status
      // through different public responses or a skipped expensive derivation.
      await verifyAccessCode(accessCode, DUMMY_ACCESS_CODE_HASH);
      return null;
    }
    if (!owner || !correct) return null;

    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"
    `;
    return { credentialVersion: owner.credentialVersion, expiresAt: new Date(clock.now.getTime() + SESSION_LIFETIME_MS) };
  }, { maxWait: 1_000, timeout: 10_000 });

  if (!verified) return null;
  // A separate short transaction locks the owner row and rejects rotation or
  // revoke-all races. No raw token is available until that transaction commits.
  return createOwnerSession({ ...verified, authenticationMethod: "ACCESS_CODE" });
}
