import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  getAuthRateLimit: vi.fn(),
  recordAuthAttempt: vi.fn(),
  applyAuthCooldown: vi.fn(),
}));

vi.mock("@/lib/security/auth-rate-limit", () => store);

import type { AuthRateLimitIdentity, AuthRateLimitState } from "@/lib/security/auth-rate-limit";
import {
  enforceUnlockRateLimit,
  PrivateAuthRateLimitError,
} from "@/lib/security/private-auth-rate-limit";

const key = Buffer.alloc(32, 7);
const windowStartedAt = new Date("2026-10-15T12:00:00Z");

function request(headers: HeadersInit = {}): NextRequest {
  return new NextRequest("https://studio.example/api/auth/unlock", { method: "POST", headers });
}

function state(overrides: Partial<AuthRateLimitState> = {}): AuthRateLimitState {
  return {
    scope: "GLOBAL",
    keyHash: "a".repeat(64),
    attempts: 1,
    windowStartedAt,
    windowExpiresAt: new Date("2026-10-15T12:05:00Z"),
    cooldownUntil: null,
    expiresAt: new Date("2026-10-15T12:05:00Z"),
    createdAt: windowStartedAt,
    updatedAt: windowStartedAt,
    windowExpired: false,
    coolingDown: false,
    windowRemainingSeconds: 300,
    cooldownRemainingSeconds: 0,
    ...overrides,
  };
}

// This models atomic returned counts for policy tests. PostgreSQL atomicity and
// independent application instances are covered by the integration suite.
function memoryStore() {
  const rows = new Map<string, AuthRateLimitState>();
  const id = (bucket: AuthRateLimitIdentity) => `${bucket.scope}:${bucket.keyHash}`;
  store.getAuthRateLimit.mockImplementation(async (bucket: AuthRateLimitIdentity) => {
    const row = rows.get(id(bucket));
    return row ? { ...row } : null;
  });
  store.recordAuthAttempt.mockImplementation(async (bucket: AuthRateLimitIdentity & { windowMs: number }) => {
    const previous = rows.get(id(bucket));
    const next = state({
      ...bucket,
      attempts: previous && !previous.windowExpired ? previous.attempts + 1 : 1,
      windowExpiresAt: new Date(windowStartedAt.getTime() + bucket.windowMs),
      windowRemainingSeconds: bucket.windowMs / 1_000,
      cooldownUntil: previous?.cooldownUntil ?? null,
      coolingDown: previous?.coolingDown ?? false,
      cooldownRemainingSeconds: previous?.cooldownRemainingSeconds ?? 0,
    });
    rows.set(id(bucket), next);
    return { ...next };
  });
  store.applyAuthCooldown.mockImplementation(async (bucket: AuthRateLimitIdentity) => {
    const previous = rows.get(id(bucket));
    if (!previous || previous.windowExpired) return null;
    const next = {
      ...previous,
      cooldownUntil: previous.windowExpiresAt,
      coolingDown: true,
      cooldownRemainingSeconds: previous.windowRemainingSeconds,
    };
    rows.set(id(bucket), next);
    return { ...next };
  });
  return rows;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VERCEL", "1");
  store.getAuthRateLimit.mockResolvedValue(null);
  store.recordAuthAttempt.mockImplementation(async (bucket: AuthRateLimitIdentity) => state(bucket));
  store.applyAuthCooldown.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("unlock source trust and privacy", () => {
  it("uses the Vercel source and global budgets with scoped HMAC identities", async () => {
    await expect(enforceUnlockRateLimit(request({
      "x-vercel-forwarded-for": "192.0.2.1",
      "x-forwarded-for": "198.51.100.8",
      "x-real-ip": "198.51.100.9",
    }), key)).resolves.toEqual({ sourceLimitApplied: true });
    expect(store.recordAuthAttempt.mock.calls.map(([bucket]) => bucket)).toEqual([
      {
        scope: "GLOBAL",
        keyHash: createHmac("sha256", key).update("cr8or:private-auth:unlock:GLOBAL\0owner").digest("hex"),
        windowMs: 300_000,
      },
      {
        scope: "SOURCE",
        keyHash: createHmac("sha256", key).update("cr8or:private-auth:unlock:SOURCE\0").update("192.0.2.1").digest("hex"),
        windowMs: 900_000,
      },
    ]);
    const persistedInputs = JSON.stringify([store.getAuthRateLimit.mock.calls, store.recordAuthAttempt.mock.calls]);
    expect(persistedInputs).not.toContain("192.0.2.1");
    expect(persistedInputs).not.toContain("198.51.100");
  });

  it.each([undefined, "", "0", "true"])("ignores all forwarding claims when VERCEL is %s", async (platform) => {
    vi.stubEnv("VERCEL", platform);
    await expect(enforceUnlockRateLimit(request({
      "x-vercel-forwarded-for": "192.0.2.1",
      "x-forwarded-for": "192.0.2.2",
      "x-real-ip": "192.0.2.3",
      "forwarded": "for=192.0.2.4",
      "x-vercel-id": "request-cannot-assert-platform",
      "vercel": "1",
    }), key)).resolves.toEqual({ sourceLimitApplied: false });
    expect(store.recordAuthAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope: "GLOBAL" }));
  });

  it("does not fall back to other IP headers on Vercel", async () => {
    await expect(enforceUnlockRateLimit(request({
      "x-forwarded-for": "192.0.2.1",
      "x-real-ip": "192.0.2.2",
      "forwarded": "for=192.0.2.3",
    }), key)).resolves.toEqual({ sourceLimitApplied: false });
    expect(store.recordAuthAttempt).toHaveBeenCalledOnce();
  });

  it.each([
    "", "192.0.2.1, 192.0.2.2", "192.0.2.1,", "localhost", "192.0.2.1:443",
    "[2001:db8::1]", "[2001:db8::1]:443", "fe80::1%eth0", "127.1", "192.000.2.1",
    "0x7f000001", "999.0.0.1", "192.0.2.1 192.0.2.2", "a".repeat(46),
  ])("keeps global protection for an invalid single-IP value %s", async (value) => {
    await expect(enforceUnlockRateLimit(request({ "x-vercel-forwarded-for": value }), key))
      .resolves.toEqual({ sourceLimitApplied: false });
    expect(store.recordAuthAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope: "GLOBAL" }));
  });

  it("rejects duplicate source headers merged into a chain", async () => {
    const headers = new Headers();
    headers.append("x-vercel-forwarded-for", "192.0.2.1");
    headers.append("x-vercel-forwarded-for", "192.0.2.2");
    await expect(enforceUnlockRateLimit(request(headers), key)).resolves.toEqual({ sourceLimitApplied: false });
  });

  it.each([
    ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["0:0:0:0:0:ffff:c000:0201", "::ffff:192.0.2.1"],
  ])("canonicalizes equivalent IPv6 sources %s and %s", async (first, second) => {
    await enforceUnlockRateLimit(request({ "x-vercel-forwarded-for": first }), key);
    await enforceUnlockRateLimit(request({ "x-vercel-forwarded-for": second }), key);
    const sourceCalls = store.recordAuthAttempt.mock.calls.filter(([bucket]) => bucket.scope === "SOURCE");
    expect(sourceCalls).toHaveLength(2);
    expect(sourceCalls[0][0].keyHash).toBe(sourceCalls[1][0].keyHash);
  });

  it("keys global and source identities with the configured secret", async () => {
    const input = request({ "x-vercel-forwarded-for": "192.0.2.1" });
    await enforceUnlockRateLimit(input, key);
    await enforceUnlockRateLimit(input, Buffer.alloc(32, 8));
    const hashes = store.recordAuthAttempt.mock.calls.map(([bucket]) => bucket.keyHash);
    expect(new Set(hashes).size).toBe(4);
  });

  it.each([Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)])("rejects an invalid key before storage", async (invalid) => {
    await expect(enforceUnlockRateLimit(request(), invalid)).rejects.toThrow(TypeError);
    expect(store.getAuthRateLimit).not.toHaveBeenCalled();
  });
});

describe("unlock fixed-window policy", () => {
  it("accepts exactly five requests per source and does not extend cooldown on denied traffic", async () => {
    const rows = memoryStore();
    const input = request({ "x-vercel-forwarded-for": "192.0.2.1" });
    for (let index = 0; index < 5; index++) {
      await expect(enforceUnlockRateLimit(input, key)).resolves.toEqual({ sourceLimitApplied: true });
    }
    await expect(enforceUnlockRateLimit(input, key)).rejects.toMatchObject({ retryAfter: 900 });
    const source = [...rows.values()].find((row) => row.scope === "SOURCE")!;
    expect(source.attempts).toBe(6);
    expect(source.cooldownUntil).toEqual(source.windowExpiresAt);
    expect(store.applyAuthCooldown).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      scope: "SOURCE", windowStartedAt, untilWindowEnd: true,
    }));
    for (let index = 0; index < 3; index++) {
      await expect(enforceUnlockRateLimit(input, key)).rejects.toBeInstanceOf(PrivateAuthRateLimitError);
    }
    expect(store.applyAuthCooldown).toHaveBeenCalledOnce();
    expect(store.recordAuthAttempt.mock.calls.filter(([bucket]) => bucket.scope === "SOURCE")).toHaveLength(6);
    expect(store.recordAuthAttempt.mock.calls.filter(([bucket]) => bucket.scope === "GLOBAL")).toHaveLength(9);
  });

  it("accepts exactly thirty global requests without any trusted source", async () => {
    memoryStore();
    vi.stubEnv("VERCEL", undefined);
    for (let index = 0; index < 30; index++) await enforceUnlockRateLimit(request(), key);
    await expect(enforceUnlockRateLimit(request(), key)).rejects.toMatchObject({ retryAfter: 300 });
    await expect(enforceUnlockRateLimit(request(), key)).rejects.toBeInstanceOf(PrivateAuthRateLimitError);
    expect(store.recordAuthAttempt).toHaveBeenCalledTimes(31);
    expect(store.applyAuthCooldown).toHaveBeenCalledOnce();
  });

  it("enforces global capacity even when every request has a different trusted source", async () => {
    memoryStore();
    for (let index = 1; index <= 30; index++) {
      await enforceUnlockRateLimit(request({ "x-vercel-forwarded-for": `192.0.2.${index}` }), key);
    }
    await expect(enforceUnlockRateLimit(request({ "x-vercel-forwarded-for": "192.0.2.31" }), key))
      .rejects.toMatchObject({ retryAfter: 300 });
    expect(store.recordAuthAttempt.mock.calls.filter(([bucket]) => bucket.scope === "SOURCE")).toHaveLength(30);
  });

  it.each([
    { source: true, requests: 20, accepted: 5 },
    { source: false, requests: 60, accepted: 30 },
  ])("uses atomic returned counts for concurrent reservations: %j", async ({ source, requests, accepted }) => {
    memoryStore();
    const input = request(source ? { "x-vercel-forwarded-for": "192.0.2.1" } : {});
    const results = await Promise.allSettled(Array.from({ length: requests }, () => enforceUnlockRateLimit(input, key)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(accepted);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(PrivateAuthRateLimitError);
    }
    expect(store.applyAuthCooldown).toHaveBeenCalledOnce();
  });

  it("rejects an atomic overrun even when its earlier snapshot was below budget and cooldown became stale", async () => {
    store.getAuthRateLimit.mockResolvedValue(state({ attempts: 29 }));
    store.recordAuthAttempt.mockResolvedValue(state({ attempts: 31, windowRemainingSeconds: 17 }));
    store.applyAuthCooldown.mockResolvedValue(null);
    await expect(enforceUnlockRateLimit(request(), key)).rejects.toMatchObject({ retryAfter: 17 });
    expect(store.applyAuthCooldown).toHaveBeenCalledOnce();
  });

  it("uses persisted cooldown state returned by the update", async () => {
    store.recordAuthAttempt.mockResolvedValue(state({ attempts: 31, windowRemainingSeconds: 17 }));
    store.applyAuthCooldown.mockResolvedValue(state({
      attempts: 31, coolingDown: true, windowRemainingSeconds: 16, cooldownRemainingSeconds: 16,
    }));
    await expect(enforceUnlockRateLimit(request(), key)).rejects.toMatchObject({ retryAfter: 16 });
  });

  it("rejects existing cooldown using database time despite an expired window and application clock skew", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2099-01-01").getTime());
    store.getAuthRateLimit.mockResolvedValue(state({
      attempts: 31, windowExpired: true, windowRemainingSeconds: 0,
      coolingDown: true, cooldownRemainingSeconds: 23,
    }));
    await expect(enforceUnlockRateLimit(request(), key)).rejects.toMatchObject({ retryAfter: 23 });
    expect(store.recordAuthAttempt).not.toHaveBeenCalled();
    expect(store.applyAuthCooldown).not.toHaveBeenCalled();
  });

  it("uses the longer active database-derived retry duration", async () => {
    store.getAuthRateLimit.mockResolvedValue(state({
      attempts: 31, windowRemainingSeconds: 29, coolingDown: true, cooldownRemainingSeconds: 61,
    }));
    await expect(enforceUnlockRateLimit(request(), key)).rejects.toMatchObject({ retryAfter: 61 });
  });

  it("allows a new atomic reservation after the database reports expiry", async () => {
    store.getAuthRateLimit.mockResolvedValue(state({
      attempts: 100, windowExpired: true, coolingDown: false, windowRemainingSeconds: 0,
    }));
    await expect(enforceUnlockRateLimit(request(), key)).resolves.toEqual({ sourceLimitApplied: false });
    expect(store.recordAuthAttempt).toHaveBeenCalledOnce();
  });

  it("rejects a cooldown introduced between the precheck and atomic reservation", async () => {
    store.recordAuthAttempt.mockResolvedValue(state({
      attempts: 1, windowExpired: false, coolingDown: true, cooldownRemainingSeconds: 8,
    }));
    await expect(enforceUnlockRateLimit(request(), key)).rejects.toMatchObject({ retryAfter: 8 });
    expect(store.applyAuthCooldown).not.toHaveBeenCalled();
  });

  it("returns a positive integer retry interval and a generic public error", () => {
    const error = new PrivateAuthRateLimitError(0.1);
    expect(error.retryAfter).toBe(1);
    expect(error.message).toBe("Too many authentication attempts. Try again later.");
    expect(error).not.toHaveProperty("cause");
  });

  it.each(["getAuthRateLimit", "recordAuthAttempt", "applyAuthCooldown"] as const)(
    "propagates %s storage failures for fail-closed service handling",
    async (operation) => {
      const failure = new Error("Authentication attempt storage is unavailable.");
      store.recordAuthAttempt.mockResolvedValue(state({ attempts: 31 }));
      store[operation].mockRejectedValue(failure);
      await expect(enforceUnlockRateLimit(request(), key)).rejects.toBe(failure);
    },
  );
});
