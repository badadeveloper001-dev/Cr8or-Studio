import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import type { NextRequest } from "next/server";

import {
  applyAuthCooldown,
  getAuthRateLimit,
  recordAuthAttempt,
  type AuthRateLimitIdentity,
  type AuthRateLimitState,
} from "@/lib/security/auth-rate-limit";

const SOURCE_BUDGET = 5;
const SOURCE_WINDOW_MS = 15 * 60 * 1_000;
const GLOBAL_BUDGET = 30;
const GLOBAL_WINDOW_MS = 5 * 60 * 1_000;

export class PrivateAuthRateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Too many authentication attempts. Try again later.");
    this.name = "PrivateAuthRateLimitError";
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}

function trustedSource(request: NextRequest): string | null {
  // VERCEL is the deployment's platform assertion, never a request header.
  // Vercel overwrites forwarding information at its edge. Other deployments
  // cannot authenticate a client-supplied forwarding header and use global only.
  if (process.env.VERCEL !== "1") return null;
  const value = request.headers.get("x-vercel-forwarded-for");
  if (!value || value.length > 45 || value.includes(",") || value.includes("%")) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  // URL's IPv6 serializer folds equivalent expansion, casing, and embedded
  // IPv4 spellings into the same identity before hashing.
  return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}

function identity(
  scope: AuthRateLimitIdentity["scope"],
  value: string,
  key: Buffer,
): AuthRateLimitIdentity {
  return {
    scope,
    keyHash: createHmac("sha256", key)
      .update(`cr8or:private-auth:unlock:${scope}\0`)
      .update(value)
      .digest("hex"),
  };
}

function blockedRetryAfter(state: AuthRateLimitState, budget: number): number | null {
  const overBudget = !state.windowExpired && state.attempts > budget;
  if (!overBudget && !state.coolingDown) return null;
  // These durations and booleans share the database statement's clock. An
  // application server's skew cannot decide whether a window has expired.
  return Math.max(
    1,
    overBudget ? state.windowRemainingSeconds : 0,
    state.coolingDown ? state.cooldownRemainingSeconds : 0,
  );
}

async function enforceBucket(
  bucket: AuthRateLimitIdentity,
  budget: number,
  windowMs: number,
): Promise<void> {
  const current = await getAuthRateLimit(bucket);
  const currentRetry = current && blockedRetryAfter(current, budget);
  if (currentRetry) throw new PrivateAuthRateLimitError(currentRetry);

  // A precheck cannot reserve capacity: only the atomic increment's returned
  // count can admit this request when several instances race.
  const recorded = await recordAuthAttempt({ ...bucket, windowMs });
  const retryAfter = blockedRetryAfter(recorded, budget);
  if (retryAfter === null) return;

  if (recorded.attempts === budget + 1 && !recorded.coolingDown) {
    const cooled = await applyAuthCooldown({
      ...bucket,
      windowStartedAt: recorded.windowStartedAt,
      untilWindowEnd: true,
    });
    // An expired/replaced window may reject the cooldown write. This request
    // still exceeded its atomic reservation and cannot proceed to verification.
    throw new PrivateAuthRateLimitError(cooled ? blockedRetryAfter(cooled, budget) ?? retryAfter : retryAfter);
  }
  throw new PrivateAuthRateLimitError(retryAfter);
}

/** Counts unlock requests before expensive verification; store failures propagate. */
export async function enforceUnlockRateLimit(
  request: NextRequest,
  rateLimitKey: Buffer,
): Promise<{ sourceLimitApplied: boolean }> {
  if (!Buffer.isBuffer(rateLimitKey) || rateLimitKey.length !== 32) {
    throw new TypeError("Authentication rate-limit key must contain 32 bytes.");
  }

  // Global protection remains in force even when a source is unknown or blocked.
  await enforceBucket(identity("GLOBAL", "owner", rateLimitKey), GLOBAL_BUDGET, GLOBAL_WINDOW_MS);
  const source = trustedSource(request);
  if (source === null) return { sourceLimitApplied: false };
  await enforceBucket(identity("SOURCE", source, rateLimitKey), SOURCE_BUDGET, SOURCE_WINDOW_MS);
  return { sourceLimitApplied: true };
}
