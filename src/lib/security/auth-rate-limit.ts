import "server-only";

import type { AuthRateLimit, AuthRateLimitScope } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;

export type AuthRateLimitIdentity = {
  scope: AuthRateLimitScope;
  keyHash: string;
};

export type AuthRateLimitState = AuthRateLimit & {
  windowExpired: boolean;
  coolingDown: boolean;
  windowRemainingSeconds: number;
  cooldownRemainingSeconds: number;
};

export class AuthRateLimitStoreError extends Error {
  constructor() {
    super("Authentication attempt storage is unavailable.");
    this.name = "AuthRateLimitStoreError";
  }
}

function validateIdentity({ scope, keyHash }: AuthRateLimitIdentity): void {
  if (scope !== "SOURCE" && scope !== "GLOBAL") {
    throw new TypeError("Invalid authentication attempt scope.");
  }
  if (typeof keyHash !== "string" || keyHash.length !== 64 || !/^[a-f0-9]{64}$/.test(keyHash)) {
    throw new TypeError("Authentication attempt identity must be a SHA-256 hex digest.");
  }
}

function validateDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_DURATION_MS) {
    throw new RangeError("Authentication attempt durations must be between 1 ms and 24 hours.");
  }
}

/**
 * Counts an attempt in one database operation. The caller decides which source
 * and global identities to count and which attempt thresholds to enforce.
 * A new window retains any cooldown from the previous window.
 */
export async function recordAuthAttempt({
  scope,
  keyHash,
  windowMs,
}: AuthRateLimitIdentity & { windowMs: number }): Promise<AuthRateLimitState> {
  validateIdentity({ scope, keyHash });
  validateDuration(windowMs);

  try {
    const rows = await prisma.$queryRaw<AuthRateLimitState[]>`
      WITH clock AS (
        SELECT (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
      ), recorded AS (
        INSERT INTO "AuthRateLimit" (
          "scope", "keyHash", "attempts", "windowStartedAt", "windowExpiresAt",
          "cooldownUntil", "expiresAt", "createdAt", "updatedAt"
        )
        SELECT ${scope}::"AuthRateLimitScope", ${keyHash}, 1, clock.at,
          clock.at + ${windowMs} * INTERVAL '1 millisecond', NULL,
          clock.at + ${windowMs} * INTERVAL '1 millisecond', clock.at, clock.at
        FROM clock
        ON CONFLICT ("scope", "keyHash") DO UPDATE SET
          "attempts" = CASE
            WHEN "AuthRateLimit"."windowExpiresAt" <= EXCLUDED."windowStartedAt" THEN 1
            ELSE "AuthRateLimit"."attempts" + 1
          END,
          "windowStartedAt" = CASE
            WHEN "AuthRateLimit"."windowExpiresAt" <= EXCLUDED."windowStartedAt"
              THEN EXCLUDED."windowStartedAt"
            ELSE "AuthRateLimit"."windowStartedAt"
          END,
          "windowExpiresAt" = CASE
            WHEN "AuthRateLimit"."windowExpiresAt" <= EXCLUDED."windowStartedAt"
              THEN EXCLUDED."windowExpiresAt"
            ELSE "AuthRateLimit"."windowExpiresAt"
          END,
          "expiresAt" = GREATEST(
            CASE
              WHEN "AuthRateLimit"."windowExpiresAt" <= EXCLUDED."windowStartedAt"
                THEN EXCLUDED."windowExpiresAt"
              ELSE "AuthRateLimit"."windowExpiresAt"
            END,
            "AuthRateLimit"."cooldownUntil"
          ),
          "updatedAt" = GREATEST("AuthRateLimit"."updatedAt", EXCLUDED."updatedAt")
        RETURNING *
      )
      SELECT recorded.*,
        recorded."windowExpiresAt" <= clock.at AS "windowExpired",
        COALESCE(recorded."cooldownUntil" > clock.at, false) AS "coolingDown",
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM (recorded."windowExpiresAt" - clock.at))))::integer
          AS "windowRemainingSeconds",
        GREATEST(0, COALESCE(CEIL(EXTRACT(EPOCH FROM (recorded."cooldownUntil" - clock.at))), 0))::integer
          AS "cooldownRemainingSeconds"
      FROM recorded CROSS JOIN clock
    `;
    if (rows.length !== 1) throw new AuthRateLimitStoreError();
    return rows[0];
  } catch {
    // Database errors can contain query parameters; do not expose or log them.
    throw new AuthRateLimitStoreError();
  }
}

/** Returns expired state too, so the caller can distinguish it from no record. */
export async function getAuthRateLimit({
  scope,
  keyHash,
}: AuthRateLimitIdentity): Promise<AuthRateLimitState | null> {
  validateIdentity({ scope, keyHash });

  try {
    const rows = await prisma.$queryRaw<AuthRateLimitState[]>`
      WITH clock AS (
        SELECT (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
      )
      SELECT limits.*,
        limits."windowExpiresAt" <= clock.at AS "windowExpired",
        COALESCE(limits."cooldownUntil" > clock.at, false) AS "coolingDown",
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM (limits."windowExpiresAt" - clock.at))))::integer
          AS "windowRemainingSeconds",
        GREATEST(0, COALESCE(CEIL(EXTRACT(EPOCH FROM (limits."cooldownUntil" - clock.at))), 0))::integer
          AS "cooldownRemainingSeconds"
      FROM "AuthRateLimit" AS limits CROSS JOIN clock
      WHERE limits."scope" = ${scope}::"AuthRateLimitScope"
        AND limits."keyHash" = ${keyHash}
    `;
    return rows[0] ?? null;
  } catch {
    throw new AuthRateLimitStoreError();
  }
}

/**
 * Applies a bounded cooldown only to the still-live window the caller observed.
 * A stale decision returns null; a concurrent longer cooldown is never shortened.
 * untilWindowEnd gives fixed-window policies a deadline that traffic cannot extend.
 */
export async function applyAuthCooldown(options: AuthRateLimitIdentity & {
  windowStartedAt: Date;
} & (
  | { durationMs: number; untilWindowEnd?: false }
  | { durationMs?: never; untilWindowEnd: true }
)): Promise<AuthRateLimitState | null> {
  const { scope, keyHash, windowStartedAt } = options;
  const untilWindowEnd = options.untilWindowEnd === true;
  const durationMs = untilWindowEnd ? 1 : options.durationMs;
  validateIdentity({ scope, keyHash });
  validateDuration(durationMs);
  if (!(windowStartedAt instanceof Date) || !Number.isFinite(windowStartedAt.getTime())) {
    throw new TypeError("An observed authentication attempt window is required.");
  }

  try {
    const rows = await prisma.$queryRaw<AuthRateLimitState[]>`
      WITH clock AS (
        SELECT (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
      ), updated AS (
        UPDATE "AuthRateLimit" AS limits SET
          "cooldownUntil" = GREATEST(
            limits."cooldownUntil",
            CASE WHEN ${untilWindowEnd} THEN limits."windowExpiresAt"
              ELSE clock.at + ${durationMs} * INTERVAL '1 millisecond' END
          ),
          "expiresAt" = GREATEST(
            limits."windowExpiresAt", limits."cooldownUntil",
            CASE WHEN ${untilWindowEnd} THEN limits."windowExpiresAt"
              ELSE clock.at + ${durationMs} * INTERVAL '1 millisecond' END
          ),
          "updatedAt" = GREATEST(limits."updatedAt", clock.at)
        FROM clock
        WHERE limits."scope" = ${scope}::"AuthRateLimitScope"
          AND limits."keyHash" = ${keyHash}
          AND limits."windowStartedAt" = (${windowStartedAt}::timestamptz AT TIME ZONE 'UTC')
          AND limits."windowExpiresAt" > clock.at
        RETURNING limits.*
      )
      SELECT updated.*,
        updated."windowExpiresAt" <= clock.at AS "windowExpired",
        COALESCE(updated."cooldownUntil" > clock.at, false) AS "coolingDown",
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM (updated."windowExpiresAt" - clock.at))))::integer
          AS "windowRemainingSeconds",
        GREATEST(0, COALESCE(CEIL(EXTRACT(EPOCH FROM (updated."cooldownUntil" - clock.at))), 0))::integer
          AS "cooldownRemainingSeconds"
      FROM updated CROSS JOIN clock
    `;
    return rows[0] ?? null;
  } catch {
    throw new AuthRateLimitStoreError();
  }
}

/** Invoke from a future controlled maintenance job; ordinary imports do no work. */
export async function cleanupExpiredAuthRateLimits(): Promise<number> {
  try {
    return await prisma.$executeRaw`
      DELETE FROM "AuthRateLimit"
      WHERE "expiresAt" <= (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
    `;
  } catch {
    throw new AuthRateLimitStoreError();
  }
}
