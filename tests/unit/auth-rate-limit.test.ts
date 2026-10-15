import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: database }));

import {
  applyAuthCooldown,
  AuthRateLimitStoreError,
  cleanupExpiredAuthRateLimits,
  getAuthRateLimit,
  recordAuthAttempt,
  type AuthRateLimitIdentity,
  type AuthRateLimitState,
} from "@/lib/security/auth-rate-limit";

const identity: AuthRateLimitIdentity = { scope: "SOURCE", keyHash: "a".repeat(64) };
const observedWindow = new Date("2026-10-15T12:00:00.000Z");

function state(overrides: Partial<AuthRateLimitState> = {}): AuthRateLimitState {
  return {
    ...identity,
    attempts: 1,
    windowStartedAt: observedWindow,
    windowExpiresAt: new Date("2026-10-15T12:15:00.000Z"),
    cooldownUntil: null,
    expiresAt: new Date("2026-10-15T12:15:00.000Z"),
    createdAt: observedWindow,
    updatedAt: observedWindow,
    windowExpired: false,
    coolingDown: false,
    ...overrides,
  };
}

beforeEach(() => vi.resetAllMocks());

describe("authentication attempt persistence inputs", () => {
  it.each(["source", "OWNER", "", undefined])("rejects invalid scope %s before a query", async (scope) => {
    await expect(recordAuthAttempt({ ...identity, scope, windowMs: 1_000 } as Parameters<typeof recordAuthAttempt>[0]))
      .rejects.toThrow(TypeError);
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "A".repeat(64), "a".repeat(63), "g".repeat(64), "a".repeat(65), `${"a".repeat(64)}\n`])(
    "rejects a noncanonical identity digest before a query",
    async (keyHash) => {
      await expect(getAuthRateLimit({ ...identity, keyHash })).rejects.toThrow(TypeError);
      expect(database.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001])(
    "rejects unbounded or invalid window/cooldown duration %s",
    async (durationMs) => {
      await expect(recordAuthAttempt({ ...identity, windowMs: durationMs })).rejects.toThrow(RangeError);
      await expect(applyAuthCooldown({ ...identity, windowStartedAt: observedWindow, durationMs }))
        .rejects.toThrow(RangeError);
      expect(database.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it("requires the observed window for a cooldown decision", async () => {
    await expect(applyAuthCooldown({ ...identity, windowStartedAt: new Date(Number.NaN), durationMs: 1_000 }))
      .rejects.toThrow(TypeError);
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("passes source/global identities and durations as bound query parameters", async () => {
    const globalIdentity = { ...identity, scope: "GLOBAL" as const };
    const expected = state({ scope: "GLOBAL" });
    database.$queryRaw.mockResolvedValue([expected]);
    await expect(recordAuthAttempt({ ...globalIdentity, windowMs: 86_400_000 })).resolves.toEqual(expected);
    const [strings, ...parameters] = database.$queryRaw.mock.calls[0];
    expect(Array.isArray(strings)).toBe(true);
    expect(parameters).toContain(globalIdentity.scope);
    expect(parameters).toContain(globalIdentity.keyHash);
    expect(parameters).toContain(86_400_000);
    expect(strings.join("")).not.toContain(globalIdentity.keyHash);
  });
});

describe("authentication attempt persistence results", () => {
  it("returns database-derived expiration and cooldown state without a local-clock override", async () => {
    const expected = state({ windowExpired: true, coolingDown: true, cooldownUntil: observedWindow });
    database.$queryRaw.mockResolvedValue([expected]);
    await expect(getAuthRateLimit(identity)).resolves.toEqual(expected);
  });

  it("distinguishes an absent record from a database failure", async () => {
    database.$queryRaw.mockResolvedValue([]);
    await expect(getAuthRateLimit(identity)).resolves.toBeNull();
  });

  it("returns null when no current matching window accepted a cooldown", async () => {
    database.$queryRaw.mockResolvedValue([]);
    await expect(applyAuthCooldown({ ...identity, windowStartedAt: observedWindow, durationMs: 1_000 }))
      .resolves.toBeNull();
  });

  it("returns persisted cooldown state and binds the observed window", async () => {
    const expected = state({ cooldownUntil: new Date("2026-10-15T12:10:00Z"), coolingDown: true });
    database.$queryRaw.mockResolvedValue([expected]);
    await expect(applyAuthCooldown({ ...identity, windowStartedAt: observedWindow, durationMs: 1_000 }))
      .resolves.toEqual(expected);
    expect(database.$queryRaw.mock.calls[0].slice(1)).toContain(observedWindow);
  });

  it("reports the database cleanup count", async () => {
    database.$executeRaw.mockResolvedValue(3);
    await expect(cleanupExpiredAuthRateLimits()).resolves.toBe(3);
  });

  it("fails closed if an attempt was not persisted", async () => {
    database.$queryRaw.mockResolvedValue([]);
    await expect(recordAuthAttempt({ ...identity, windowMs: 1_000 })).rejects.toThrow(AuthRateLimitStoreError);
  });

  it.each([
    () => recordAuthAttempt({ ...identity, windowMs: 1_000 }),
    () => getAuthRateLimit(identity),
    () => applyAuthCooldown({ ...identity, windowStartedAt: observedWindow, durationMs: 1_000 }),
    () => cleanupExpiredAuthRateLimits(),
  ])("reports database failures without exposing original details", async (operation) => {
    const privateFailure = new Error("database connection string and request parameters");
    database.$queryRaw.mockRejectedValue(privateFailure);
    database.$executeRaw.mockRejectedValue(privateFailure);
    await expect(operation()).rejects.toEqual(new AuthRateLimitStoreError());
    await expect(operation()).rejects.not.toHaveProperty("cause");
  });
});
