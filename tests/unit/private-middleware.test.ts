import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), supabase: vi.fn() }));
vi.mock("@/lib/security/session-store", () => ({ resolveOwnerSession: mocks.session }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseClient: mocks.supabase }));

import { middleware } from "@/middleware";
import { getFeatureFlags, isFeatureEnabled } from "@/lib/config/feature-flags";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";

const privateKeys = [
  "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY",
] as const;
const origin = "http://localhost:3000";
const token = Buffer.alloc(32, 7).toString("base64url");
const key = Buffer.alloc(32, 17).toString("base64url");

function enablePrivateAuth() {
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "true");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", origin);
  vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", key);
}

function request(path: string, method = "GET", cookie = false, extra: Record<string, string> = {}) {
  return new NextRequest(`${origin}${path}`, {
    method,
    headers: { origin, "x-cr8or-auth": "1", ...(cookie ? { cookie: `cr8or-dev-session=${token}` } : {}), ...extra },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of [...privateKeys, "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CR8OR_FEATURE_AUTH_GUARD", "false");
  vi.stubEnv("CR8OR_FEATURE_AUDIT_LOG", "false");
  mocks.session.mockResolvedValue({ ownerId: "owner" });
});
afterEach(() => vi.unstubAllEnvs());

describe("coherent private authentication activation", () => {
  it.each([undefined, "false"])("preserves deliberately inactive staging for %s alone", async (enabled) => {
    vi.stubEnv(privateKeys[0], enabled);
    expect(getPrivateAuthMode()).toBe("inactive");
    expect(isFeatureEnabled("authGuard")).toBe(false);
    expect((await middleware(request("/api/projects"))).headers.get("x-middleware-next")).toBe("1");
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it.each(["", "TRUE", " false ", "1", "yes", "invalid", "true"])(
    "fails closed for incomplete or malformed activation %s", async (enabled) => {
      vi.stubEnv(privateKeys[0], enabled);
      expect(getPrivateAuthMode()).toBe("required");
      expect(getFeatureFlags().authGuard).toBe(true);
      const response = await middleware(request("/api/projects"));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.session).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "false"])("never treats partial config with enabled=%s as inactive", async (enabled) => {
    for (const configuredKey of privateKeys.slice(1)) {
      for (const value of ["", configuredKey.includes("ORIGIN") ? origin : key]) {
        for (const name of privateKeys) vi.stubEnv(name, undefined);
        vi.stubEnv(privateKeys[0], enabled);
        vi.stubEnv(configuredKey, value);
        expect(getPrivateAuthMode()).toBe("required");
        expect((await middleware(request("/api/projects"))).status).toBe(503);
      }
    }
  });

  it("overrides every legacy auth-guard value without caching configuration", async () => {
    enablePrivateAuth();
    for (const legacy of [undefined, "false", "true", "invalid"]) {
      vi.stubEnv("CR8OR_FEATURE_AUTH_GUARD", legacy);
      expect(isFeatureEnabled("authGuard")).toBe(true);
      expect((await middleware(request("/api/projects"))).status).toBe(401);
    }
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", "https://invalid.example/path");
    expect((await middleware(request("/api/projects", "GET", true))).status).toBe(503);
    expect(mocks.session).not.toHaveBeenCalled();
  });
});

describe("private middleware boundary", () => {
  beforeEach(enablePrivateAuth);

  it.each([
    ["/api/auth/unlock", "POST"], ["/api/auth/session", "GET"], ["/api/auth/lock", "POST"],
  ])("preserves exactly public %s %s without requiring an existing cookie", async (path, method) => {
    const response = await middleware(request(path, method));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/auth/unlock", "POST"], ["/api/auth/session", "GET"], ["/api/auth/lock", "POST"],
  ])("rejects all unsupported methods for %s with Allow=%s", async (path, allowed) => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].filter((m) => m !== allowed)) {
      const response = await middleware(request(path, method));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allowed);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it.each(["/api/auth/setup", "/api/auth/session/nested", "/api/auth/session-extra", "/api/health/slis"])(
    "does not exempt %s or its preflight", async (path) => {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const response = await middleware(request(path, method));
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.has("x-middleware-next")).toBe(false);
      }
    },
  );

  it("requires database validation rather than cookie or authorization-header presence", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await middleware(request("/api/projects", "GET", true, {
      authorization: "Bearer synthetic-legacy-token", "x-cr8or-token": "synthetic-legacy-token",
      "x-owner-id": "owner", "x-role": "owner",
    }));
    expect(response.status).toBe(401);
    expect(mocks.session).toHaveBeenCalledWith(token);
    expect(mocks.supabase).not.toHaveBeenCalled();
  });

  it("does not forward a trusted identity or cache a successful resolution", async () => {
    const first = await middleware(request("/api/projects", "GET", true));
    expect(first.headers.get("x-middleware-next")).toBe("1");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.has("x-middleware-override-headers")).toBe(false);
    mocks.session.mockResolvedValue(null);
    expect((await middleware(request("/api/projects", "GET", true))).status).toBe(401);
    expect(mocks.session).toHaveBeenCalledTimes(2);
  });

  it("fails closed without exposing database details", async () => {
    mocks.session.mockRejectedValue(new Error("private database details"));
    const response = await middleware(request("/api/security/readiness", "GET", true));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("private database details");
  });

  it.each(["/api/chat/main", "/api/orchestrate", "/api/orchestrate/stream"])(
    "passes authenticated execution at %s to its project authorization boundary", async (path) => {
      const response = await middleware(request(path, "POST", true));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it("leaves the frontend shell to the later locking stage", async () => {
    expect((await middleware(request("/"))).headers.get("x-middleware-next")).toBe("1");
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
