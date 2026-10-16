import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { PrismaClient, type OwnerCredential } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Never read DATABASE_URL, DIRECT_URL, or .env files to choose a test service.
// Only this disposable local PostgreSQL service is allowed; each run owns a schema.
const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.pathname !== "/cr8or_auth_test"
  ) {
    throw new Error("Authentication integration tests require the isolated local test database on port 55432.");
  }
  return url;
}

const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const schemaName = `private_auth_test_${randomBytes(8).toString("hex")}`;
// Public synthetic fixtures used exclusively in a disposable test database.
const ACCESS_CODE = "synthetic-integration-only-V7!xQ2#pL9@kD4$mR8";
const NEXT_ACCESS_CODE = "synthetic-rotated-only-B3@jM8!wT2#qF6$zN9";
const WRONG_ACCESS_CODE = "synthetic-incorrect-only-C8!sJ4@rP7#vD2$mK6";
const ORIGIN = "http://localhost:3000";
const RATE_LIMIT_KEY = randomBytes(32);
const ENVIRONMENT_KEYS = [
  "DATABASE_URL", "DIRECT_URL", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL",
  "VERCEL_DEPLOYMENT_ID", "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN",
  "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", "CR8OR_DEV_API_TOKEN", "CR8OR_OWNER_IDS",
] as const;
const previousEnvironment = new Map(ENVIRONMENT_KEYS.map((name) => [name, process.env[name]]));
const previousGlobal = globalThis.prismaGlobal;

function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe.skipIf(!testUrl)("private authentication services on isolated PostgreSQL", () => {
  let admin: PrismaClient;
  let database: PrismaClient;
  let ownerFixture: OwnerCredential;
  let owners: typeof import("@/lib/security/owner-management");
  let sessions: typeof import("@/lib/security/session-store");
  let policy: typeof import("@/lib/security/private-auth-rate-limit");
  let unlockRoute: typeof import("@/app/api/auth/unlock/route");
  let sessionRoute: typeof import("@/app/api/auth/session/route");
  let lockRoute: typeof import("@/app/api/auth/lock/route");

  function enablePrivateAuth() {
    setEnvironment("NODE_ENV", "test");
    for (const name of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) {
      setEnvironment(name, undefined);
    }
    setEnvironment("CR8OR_PRIVATE_AUTH_ENABLED", "true");
    setEnvironment("CR8OR_PRIVATE_AUTH_ORIGIN", ORIGIN);
    setEnvironment("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", RATE_LIMIT_KEY.toString("base64url"));
  }

  function mutationRequest(endpoint: "unlock" | "lock", options: {
    origin?: string;
    headers?: Record<string, string>;
    body?: string;
    cookie?: string;
  } = {}) {
    const origin = options.origin ?? process.env.CR8OR_PRIVATE_AUTH_ORIGIN ?? ORIGIN;
    const headers = new Headers({ origin, "x-cr8or-auth": "1", ...options.headers });
    if (endpoint === "unlock" && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (options.cookie) headers.set("cookie", options.cookie);
    return new NextRequest(`${origin}/api/auth/${endpoint}`, {
      method: "POST", headers,
      ...(endpoint === "unlock" ? { body: options.body ?? JSON.stringify({ accessCode: ACCESS_CODE }) } : {}),
    });
  }

  function sessionRequest(cookie?: string, headers: Record<string, string> = {}) {
    return new NextRequest(`${process.env.CR8OR_PRIVATE_AUTH_ORIGIN ?? ORIGIN}/api/auth/session`, {
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
    });
  }

  const unlock = (accessCode = ACCESS_CODE) => unlockRoute.POST(mutationRequest("unlock", {
    body: JSON.stringify({ accessCode }),
  }));
  const readSession = (cookie?: string) => sessionRoute.GET(sessionRequest(cookie));

  function expectPrivateResponse(response: Response, status: number) {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  function cookieFrom(response: Response): string {
    const cookie = response.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    return cookie!.split(";", 1)[0];
  }

  async function unlockedCookie() {
    const response = await unlock();
    expectPrivateResponse(response, 200);
    return cookieFrom(response);
  }

  async function expectAuthenticated(cookie: string, authenticated: boolean) {
    const response = await readSession(cookie);
    expectPrivateResponse(response, 200);
    const body = await response.json();
    if (authenticated) {
      expect(body).toEqual({ ok: true, authenticated: true, expiresAt: expect.any(String) });
    } else {
      expect(body).toEqual({ ok: true, authenticated: false });
    }
  }

  async function applyMigration(directory: string) {
    const sql = await readFile(path.join(process.cwd(), "prisma/migrations", directory, "migration.sql"), "utf8");
    // These migrations contain ordinary DDL, without semicolons in SQL literals.
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement && !/^(BEGIN|COMMIT)$/i.test(statement));
    await database.$transaction(async (transaction) => {
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    });
  }

  async function withIndependentInstance(run: (other: {
    database: PrismaClient;
    policy: typeof policy;
    unlockRoute: typeof unlockRoute;
    sessionRoute: typeof sessionRoute;
  }) => Promise<void>) {
    const savedGlobal = globalThis.prismaGlobal;
    const savedDatabaseUrl = process.env.DATABASE_URL;
    const savedDirectUrl = process.env.DIRECT_URL;
    const url = new URL(testUrl!);
    url.search = "";
    url.searchParams.set("schema", schemaName);
    url.searchParams.set("connection_limit", "5");
    let independent: PrismaClient | undefined;
    vi.resetModules();
    delete globalThis.prismaGlobal;
    setEnvironment("DATABASE_URL", url.toString());
    setEnvironment("DIRECT_URL", url.toString());
    try {
      independent = (await import("@/lib/db/prisma")).prisma;
      expect(independent).not.toBe(database);
      await run({
        database: independent,
        policy: await import("@/lib/security/private-auth-rate-limit"),
        unlockRoute: await import("@/app/api/auth/unlock/route"),
        sessionRoute: await import("@/app/api/auth/session/route"),
      });
    } finally {
      await independent?.$disconnect();
      if (savedGlobal === undefined) delete globalThis.prismaGlobal;
      else globalThis.prismaGlobal = savedGlobal;
      setEnvironment("DATABASE_URL", savedDatabaseUrl);
      setEnvironment("DIRECT_URL", savedDirectUrl);
    }
  }

  async function expireSession(cookie: string) {
    const tokenHash = sessions.hashSessionToken(cookie.slice(cookie.indexOf("=") + 1));
    await database.authSession.update({ where: { tokenHash }, data: {
      authenticatedAt: new Date(Date.now() - 120_000),
      createdAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
    } });
  }

  async function withUnavailableTable(table: "OwnerCredential" | "AuthSession" | "AuthRateLimit", run: () => Promise<void>) {
    await database.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME TO "${table}Unavailable"`);
    try {
      await run();
    } finally {
      await database.$executeRawUnsafe(`ALTER TABLE "${table}Unavailable" RENAME TO "${table}"`);
    }
  }

  beforeAll(async () => {
    enablePrivateAuth();
    const url = new URL(testUrl!);
    url.search = "";
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    url.searchParams.set("schema", schemaName);
    url.searchParams.set("connection_limit", "5");
    setEnvironment("DATABASE_URL", url.toString());
    setEnvironment("DIRECT_URL", url.toString());
    delete globalThis.prismaGlobal;
    vi.resetModules();
    // Import application persistence only after both database URLs are isolated.
    database = (await import("@/lib/db/prisma")).prisma;
    for (const migration of ["0_init", "20250101000000_add_workspace_table", "20261015000000_authentication_foundation"]) {
      await applyMigration(migration);
    }
    owners = await import("@/lib/security/owner-management");
    sessions = await import("@/lib/security/session-store");
    policy = await import("@/lib/security/private-auth-rate-limit");
    unlockRoute = await import("@/app/api/auth/unlock/route");
    sessionRoute = await import("@/app/api/auth/session/route");
    lockRoute = await import("@/app/api/auth/lock/route");
    await owners.provisionOwner(ACCESS_CODE);
    ownerFixture = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
  }, 30_000);

  beforeEach(async () => {
    enablePrivateAuth();
    await database.authSession.deleteMany();
    await database.ownerCredential.deleteMany();
    await database.authRateLimit.deleteMany();
    // Reuse a real, once-provisioned encoded hash while each route verifies it normally.
    await database.ownerCredential.create({ data: ownerFixture });
  });

  afterAll(async () => {
    try {
      await database?.$disconnect();
      if (admin) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin?.$disconnect();
      if (previousGlobal === undefined) delete globalThis.prismaGlobal;
      else globalThis.prismaGlobal = previousGlobal;
      for (const [name, value] of previousEnvironment) setEnvironment(name, value);
    }
  });

  it("keeps every endpoint disabled by default without creating sessions or attempt records", async () => {
    delete process.env.CR8OR_PRIVATE_AUTH_ENABLED;
    const responses = [
      await unlock(), await readSession(), await lockRoute.POST(mutationRequest("lock")),
    ];
    for (const response of responses) {
      expectPrivateResponse(response, 503);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await database.authSession.count()).toBe(0);
    expect(await database.authRateLimit.count()).toBe(0);
  });

  it("rejects every unsupported HTTP method with an uncached response before persistence", async () => {
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
    for (const [endpoint, allowed, route] of [
      ["unlock", "POST", unlockRoute],
      ["session", "GET", sessionRoute],
      ["lock", "POST", lockRoute],
    ] as const) {
      for (const method of methods) {
        if (method === allowed) continue;
        const handler = route[method] as (request: NextRequest) => Response | Promise<Response>;
        expect(handler).toBeTypeOf("function");
        const response = await handler(new NextRequest(`${ORIGIN}/api/auth/${endpoint}`, { method }));
        expectPrivateResponse(response, 405);
        expect(response.headers.get("allow")).toBe(allowed);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
    }
    expect(await database.authSession.count()).toBe(0);
    expect(await database.authRateLimit.count()).toBe(0);
  });

  it("fails closed on malformed configuration and nonlocal HTTP deployments", async () => {
    const invalid = [
      ["CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", "not-a-valid-secret"],
      ["CR8OR_PRIVATE_AUTH_ORIGIN", "http://localhost:3000/"],
      ["CR8OR_PRIVATE_AUTH_ORIGIN", "http://example.test"],
      ["CR8OR_PRIVATE_AUTH_ENABLED", "1"],
      ["NODE_ENV", "production"],
      ["VERCEL", "1"],
    ];
    for (const [name, value] of invalid) {
      enablePrivateAuth();
      setEnvironment(name, value);
      expectPrivateResponse(await unlock(), 503);
      expectPrivateResponse(await readSession(), 503);
    }
    expect(await database.authSession.count()).toBe(0);
    expect(await database.authRateLimit.count()).toBe(0);
  });

  it("returns only unauthenticated status without a cookie and ignores legacy bearer/dev identities", async () => {
    setEnvironment("CR8OR_DEV_API_TOKEN", "synthetic-legacy-token");
    setEnvironment("CR8OR_OWNER_IDS", "local-dev,dev-user");
    const identities: Array<Record<string, string>> = [
      {}, { authorization: "Bearer synthetic-legacy-token" }, { "x-cr8or-token": "synthetic-legacy-token" },
    ];
    for (const headers of identities) {
      const response = await sessionRoute.GET(sessionRequest(undefined, headers));
      expectPrivateResponse(response, 200);
      expect(await response.json()).toEqual({ ok: true, authenticated: false });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("rejects missing, cross-site, forged-proxy, and noncanonical mutation origins before persistence", async () => {
    const headers: Array<Record<string, string>> = [
      { origin: "" }, { origin: "null" }, { origin: "https://attacker.test" },
      { origin: `${ORIGIN}/` }, { "x-cr8or-auth": "" }, { "x-cr8or-auth": "true" },
      { "sec-fetch-site": "cross-site" },
      { origin: "https://attacker.test", "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" },
    ];
    for (const invalid of headers) {
      expectPrivateResponse(await unlockRoute.POST(mutationRequest("unlock", { headers: invalid })), 400);
      expectPrivateResponse(await lockRoute.POST(mutationRequest("lock", { headers: invalid })), 400);
    }
    expect(await database.authSession.count()).toBe(0);
    expect(await database.authRateLimit.count()).toBe(0);
  });

  it("rejects malformed, extra-field, encoded, and oversized JSON before hashing or persistence", async () => {
    const cases: Array<{ body?: string; headers?: Record<string, string> }> = [
      { body: "{" }, { body: "null" }, { body: "[]" }, { body: "{}" },
      { body: JSON.stringify({ accessCode: 123 }) },
      { body: JSON.stringify({ accessCode: "" }) },
      { body: JSON.stringify({ accessCode: ACCESS_CODE, ownerId: "owner" }) },
      { body: JSON.stringify({ accessCode: "💡".repeat(257) }) },
      { body: " ".repeat(4_097) },
      { headers: { "content-type": "text/plain" } },
      { headers: { "content-encoding": "gzip" } },
      { headers: { "content-length": "1" } },
    ];
    for (const options of cases) {
      const response = await unlockRoute.POST(mutationRequest("unlock", options));
      expectPrivateResponse(response, 400);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).not.toContain(ACCESS_CODE);
    }
    expect(await database.authSession.count()).toBe(0);
    expect(await database.authRateLimit.count()).toBe(0);
  });

  it("unlocks with a real encoded credential, stores only a digest, and sets an absolute local session cookie", async () => {
    const response = await unlock();
    expectPrivateResponse(response, 200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, authenticated: true, expiresAt: expect.any(String) });
    const cookie = cookieFrom(response);
    expect(cookie).toMatch(/^cr8or-dev-session=[A-Za-z0-9_-]{43}$/);
    const serialized = response.headers.get("set-cookie")!;
    expect(serialized).toMatch(/; Path=\//i);
    expect(serialized).toMatch(/; HttpOnly/i);
    expect(serialized).toMatch(/; SameSite=Strict/i);
    expect(serialized).toMatch(/; Expires=/i);
    expect(serialized).not.toMatch(/; (Secure|Domain|Max-Age)(?:[;=]|$)/i);
    const token = cookie.slice(cookie.indexOf("=") + 1);
    const stored = await database.authSession.findFirstOrThrow();
    expect(stored.tokenHash).toBe(sessions.hashSessionToken(token));
    expect(stored.credentialVersion).toBe(1);
    expect(stored.authenticationMethod).toBe("ACCESS_CODE");
    expect(stored.expiresAt.toISOString()).toBe(body.expiresAt);
    expect(stored.expiresAt.getTime() - stored.authenticatedAt.getTime()).toBeGreaterThan(0);
    expect(stored.expiresAt.getTime() - stored.authenticatedAt.getTime()).toBeLessThanOrEqual(12 * 60 * 60 * 1_000);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(ACCESS_CODE);
    await expectAuthenticated(cookie, true);
  });

  it("uses a host-only Secure cookie for HTTPS and clears it with matching attributes", async () => {
    setEnvironment("NODE_ENV", "production");
    setEnvironment("CR8OR_PRIVATE_AUTH_ORIGIN", "https://studio.example.test");
    const response = await unlock();
    expectPrivateResponse(response, 200);
    const cookie = cookieFrom(response);
    expect(cookie).toMatch(/^__Host-cr8or-session=[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("set-cookie")).toMatch(/; Secure/i);
    expect(response.headers.get("set-cookie")).not.toMatch(/; Domain=/i);
    await expectAuthenticated(cookie, true);
    await expectAuthenticated(cookie.replace("__Host-cr8or-session", "cr8or-dev-session"), false);
    const locked = await lockRoute.POST(mutationRequest("lock", { cookie }));
    expectPrivateResponse(locked, 204);
    expect(locked.headers.get("set-cookie")).toMatch(/^__Host-cr8or-session=;/);
    expect(locked.headers.get("set-cookie")).toMatch(/; Secure/i);
    expect(locked.headers.get("set-cookie")).toMatch(/; HttpOnly/i);
    expect(locked.headers.get("set-cookie")).toMatch(/; SameSite=Strict/i);
    expect(locked.headers.get("set-cookie")).toMatch(/; Max-Age=0/i);
    expect(locked.headers.get("set-cookie")).not.toMatch(/; Domain=/i);
  });

  it("returns indistinguishable generic failures for incorrect and unprovisioned credentials", async () => {
    const incorrect = await unlock(WRONG_ACCESS_CODE);
    expectPrivateResponse(incorrect, 401);
    const incorrectBody = await incorrect.text();
    await database.ownerCredential.deleteMany();
    const missing = await unlock();
    expectPrivateResponse(missing, 401);
    expect(await missing.text()).toBe(incorrectBody);
    expect(incorrectBody).not.toMatch(/owner|provision|hash|credentialVersion/i);
    for (const response of [incorrect, missing]) expect(response.headers.get("set-cookie")).toBeNull();
    expect(await database.authSession.count()).toBe(0);
  });

  it("fails closed with a generic response when the stored hash is corrupt", async () => {
    await database.ownerCredential.update({ where: { id: "owner" }, data: { accessCodeHash: "invalid-encoded-credential" } });
    const response = await unlock();
    expectPrivateResponse(response, 401);
    expect(await response.text()).not.toContain("invalid-encoded-credential");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await database.authSession.count()).toBe(0);
  });

  it("rejects fabricated, malformed, duplicate, and expired cookies without extending session lifetime", async () => {
    const cookie = await unlockedCookie();
    const before = await database.authSession.findFirstOrThrow();
    await expectAuthenticated(cookie, true);
    expect((await database.authSession.findFirstOrThrow()).expiresAt).toEqual(before.expiresAt);
    for (const invalid of [
      `cr8or-dev-session=${randomBytes(32).toString("base64url")}`,
      "cr8or-dev-session=malformed", `${cookie}; ${cookie}`, `${cookie}; cr8or-dev-session`,
      cookie.replace("cr8or-dev-session", "__Host-cr8or-session"),
    ]) await expectAuthenticated(invalid, false);
    await expireSession(cookie);
    await expectAuthenticated(cookie, false);
  });

  it("locks immediately, clears the cookie, and permits an idempotent repeated lock", async () => {
    const cookie = await unlockedCookie();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await lockRoute.POST(mutationRequest("lock", { cookie }));
      expectPrivateResponse(response, 204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("set-cookie")).toMatch(/^cr8or-dev-session=;/);
      expect(response.headers.get("set-cookie")).toMatch(/; Max-Age=0/i);
      expect(response.headers.get("set-cookie")).toMatch(/; HttpOnly/i);
      expect(response.headers.get("set-cookie")).toMatch(/; SameSite=Strict/i);
      await expectAuthenticated(cookie, false);
    }
    expect((await database.authSession.findFirstOrThrow()).revokedAt).toBeInstanceOf(Date);
  });

  it("rejects cross-site lock without revoking a valid session", async () => {
    const cookie = await unlockedCookie();
    const response = await lockRoute.POST(mutationRequest("lock", {
      cookie, headers: { origin: "https://attacker.test" },
    }));
    expectPrivateResponse(response, 400);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expectAuthenticated(cookie, true);
  });

  it("clears absent and malformed cookies without requiring an existing session", async () => {
    for (const cookie of [undefined, "cr8or-dev-session=invalid"]) {
      const response = await lockRoute.POST(mutationRequest("lock", { cookie }));
      expectPrivateResponse(response, 204);
      expect(response.headers.get("set-cookie")).toMatch(/^cr8or-dev-session=;/);
    }
    expect(await database.authSession.count()).toBe(0);
  });

  it("keeps device sessions independent when one device locks", async () => {
    const first = await unlockedCookie();
    const second = await unlockedCookie();
    expect(second).not.toBe(first);
    expect(await database.authSession.count()).toBe(2);
    expectPrivateResponse(await lockRoute.POST(mutationRequest("lock", { cookie: first })), 204);
    await expectAuthenticated(first, false);
    await expectAuthenticated(second, true);
  });

  it("rotates the code atomically, preserves the WebAuthn identity, and invalidates every old device", async () => {
    const first = await unlockedCookie();
    const second = await unlockedCookie();
    const rotated = await owners.rotateOwnerAccessCode(NEXT_ACCESS_CODE);
    expect(rotated).toMatchObject({ credentialVersion: 2, revokedCount: 2 });
    expect(Object.keys(rotated).sort()).toEqual(["createdAt", "credentialVersion", "revokedCount", "updatedAt"]);
    const stored = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    expect(stored.webAuthnUserHandle).toEqual(ownerFixture.webAuthnUserHandle);
    expect(stored.createdAt).toEqual(ownerFixture.createdAt);
    expect(stored.accessCodeHash).not.toBe(ownerFixture.accessCodeHash);
    await expectAuthenticated(first, false);
    await expectAuthenticated(second, false);
    expectPrivateResponse(await unlock(), 401);
    const current = await unlock(NEXT_ACCESS_CODE);
    expectPrivateResponse(current, 200);
    await expectAuthenticated(cookieFrom(current), true);
    expect(await database.authSession.count({ where: { credentialVersion: 1, revokedAt: null } })).toBe(0);
  });

  it("revoke-all invalidates devices across application instances while allowing the unchanged code again", async () => {
    const first = await unlockedCookie();
    const second = await unlockedCookie();
    await withIndependentInstance(async (other) => {
      expect(await (await other.sessionRoute.GET(sessionRequest(first))).json()).toMatchObject({ authenticated: true });
      expect(await owners.revokeAllOwnerSessions()).toEqual({ revokedCount: 2, credentialVersion: 2 });
      for (const cookie of [first, second]) {
        const response = await other.sessionRoute.GET(sessionRequest(cookie));
        expectPrivateResponse(response, 200);
        expect(await response.json()).toEqual({ ok: true, authenticated: false });
      }
    });
    const owner = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    expect(owner.accessCodeHash).toBe(ownerFixture.accessCodeHash);
    expect(owner.webAuthnUserHandle).toEqual(ownerFixture.webAuthnUserHandle);
    await expectAuthenticated(await unlockedCookie(), true);
  });

  it("reports only safe owner metadata and rejects re-provisioning without changing the singleton", async () => {
    await unlockedCookie();
    const status = await owners.inspectOwnerStatus();
    expect(status).toEqual({
      provisioned: true, credentialVersion: 1, createdAt: expect.any(Date), updatedAt: expect.any(Date),
      sessions: { total: 1, active: 1, revoked: 0, expired: 0 },
    });
    expect(JSON.stringify(status)).not.toMatch(/accessCodeHash|webAuthnUserHandle|tokenHash/);
    await expect(owners.provisionOwner(NEXT_ACCESS_CODE)).rejects.toMatchObject({ code: "ALREADY_PROVISIONED" });
    expect(await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } })).toEqual(ownerFixture);
    expect(await database.ownerCredential.count()).toBe(1);
  });

  it("allows exactly one concurrent bootstrap and leaves a real stable owner identity", async () => {
    await database.ownerCredential.deleteMany();
    expect(await owners.inspectOwnerStatus()).toEqual({
      provisioned: false, credentialVersion: null, createdAt: null, updatedAt: null,
      sessions: { total: 0, active: 0, revoked: 0, expired: 0 },
    });
    const results = await Promise.allSettled([owners.provisionOwner(ACCESS_CODE), owners.provisionOwner(NEXT_ACCESS_CODE)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "ALREADY_PROVISIONED" } });
    const owner = await database.ownerCredential.findFirstOrThrow();
    expect(owner.webAuthnUserHandle).toHaveLength(32);
    expect(owner.credentialVersion).toBe(1);
    expect(await database.ownerCredential.count()).toBe(1);
    const winner = results[0].status === "fulfilled" ? ACCESS_CODE : NEXT_ACCESS_CODE;
    expectPrivateResponse(await unlock(winner), 200);
  });

  it("loads the operator CLI against the isolated schema and prints only safe status metadata", async () => {
    const url = new URL(testUrl!);
    url.search = "";
    url.searchParams.set("schema", schemaName);
    url.searchParams.set("connection_limit", "1");
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      "--conditions=react-server", "scripts/manage-owner.mjs", "status",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url.toString(), DIRECT_URL: url.toString() },
      timeout: 15_000,
    });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ok: true, operation: "status", provisioned: true, credentialVersion: 1,
      createdAt: expect.any(String), updatedAt: expect.any(String),
      sessions: { total: 0, active: 0, revoked: 0, expired: 0 },
    });
    expect(stdout).not.toContain(ACCESS_CODE);
    expect(stdout).not.toMatch(/accessCodeHash|webAuthnUserHandle|tokenHash|postgresql/);
  }, 20_000);

  it("rejects an old code verified before a queued rotation commits, without issuing a session", async () => {
    let rotation: ReturnType<typeof owners.rotateOwnerAccessCode> | undefined;
    let attempt: ReturnType<typeof unlock> | undefined;
    try {
      await database.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT "id" FROM "OwnerCredential" WHERE "id" = 'owner' FOR UPDATE`;
        const [blocker] = await transaction.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        const waitingForOwner = async (queryPattern: string, predecessor = blocker.pid) => {
          return database.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND (${blocker.pid} = ANY(pg_blocking_pids(pid))
                OR ${predecessor} = ANY(pg_blocking_pids(pid)))
              AND query LIKE ${queryPattern}
          `;
        };

        // Queue the real rotation first. While it waits, verification can read
        // the previously committed hash, but session creation must queue after it.
        rotation = owners.rotateOwnerAccessCode(NEXT_ACCESS_CODE);
        void rotation.catch(() => undefined);
        let rotationPid = blocker.pid;
        await expect.poll(async () => {
          const waiting = await waitingForOwner('%UPDATE "OwnerCredential"%');
          if (waiting[0]) rotationPid = waiting[0].pid;
          return waiting.length;
        }, { timeout: 5_000 }).toBe(1);
        attempt = unlock();
        void attempt.catch(() => undefined);
        // PostgreSQL can block this waiter on the preceding rotation's tuple
        // lock instead of directly on the original transaction's row lock.
        await expect.poll(() => waitingForOwner('%"credentialVersion"%FOR UPDATE%', rotationPid), {
          timeout: 5_000,
        }).toHaveLength(1);
      }, { timeout: 15_000 });

      expect(await rotation).toMatchObject({ credentialVersion: 2, revokedCount: 0 });
      const response = await attempt!;
      expectPrivateResponse(response, 401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await database.authSession.count()).toBe(0);
      expectPrivateResponse(await unlock(), 401);
      expectPrivateResponse(await unlock(NEXT_ACCESS_CODE), 200);
    } finally {
      // Failed assertions also release the blocker before settling queued work.
      await Promise.allSettled([rotation, attempt]);
    }
  }, 20_000);

  it("shares bounded verification capacity across instances and releases it after the database transaction", async () => {
    await withIndependentInstance(async (other) => {
      await database.$transaction(async (transaction) => {
        const [capacity] = await transaction.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(824101, 1) AS locked
        `;
        expect(capacity.locked).toBe(true);
        const responses = await Promise.all([
          unlock(), other.unlockRoute.POST(mutationRequest("unlock")),
        ]);
        for (const response of responses) {
          expectPrivateResponse(response, 429);
          expect(response.headers.get("retry-after")).toBe("1");
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(await response.text()).not.toMatch(/advisory|scrypt|Prisma|SELECT|postgresql/);
        }
        expect(await database.authSession.count()).toBe(0);
      });
    });
    expectPrivateResponse(await unlock(), 200);
    expect(await database.authSession.count()).toBe(1);
  });

  it("fails closed without credential leakage when attempt persistence is unavailable", async () => {
    await withUnavailableTable("AuthRateLimit", async () => {
      const response = await unlock();
      expectPrivateResponse(response, 503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).not.toMatch(/AuthRateLimit|Prisma|SELECT|INSERT|postgresql/);
    });
    expect(await database.authSession.count()).toBe(0);
  });

  it("fails closed when owner persistence is unavailable instead of using legacy authentication", async () => {
    const cookie = await unlockedCookie();
    setEnvironment("CR8OR_DEV_API_TOKEN", "synthetic-legacy-token");
    await withUnavailableTable("OwnerCredential", async () => {
      const response = await sessionRoute.GET(sessionRequest(cookie, { authorization: "Bearer synthetic-legacy-token" }));
      expectPrivateResponse(response, 503);
      expectPrivateResponse(await unlock(), 503);
      expect(await response.text()).not.toMatch(/OwnerCredential|Prisma|postgresql|synthetic-legacy-token/);
    });
  });

  it("fails closed for validate, unlock, and lock when session persistence is unavailable", async () => {
    const cookie = await unlockedCookie();
    await withUnavailableTable("AuthSession", async () => {
      for (const response of [
        await readSession(cookie), await unlock(), await lockRoute.POST(mutationRequest("lock", { cookie })),
      ]) {
        expectPrivateResponse(response, 503);
        expect(await response.text()).not.toMatch(/AuthSession|Prisma|postgresql/);
      }
    });
    expect(await database.authSession.count()).toBe(1);
  });

  it("atomically shares the global budget across application instances and ignores arbitrary forwarded IPs locally", async () => {
    await withIndependentInstance(async (other) => {
      const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => {
        const request = mutationRequest("unlock", { headers: {
          "x-forwarded-for": `198.51.100.${index + 1}`,
          "x-vercel-forwarded-for": `203.0.113.${index + 1}`,
        } });
        return (index % 2 ? policy : other.policy).enforceUnlockRateLimit(request, RATE_LIMIT_KEY);
      }));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(30);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(10);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ name: "PrivateAuthRateLimitError", retryAfter: expect.any(Number) });
          expect(result.reason.retryAfter).toBeGreaterThan(0);
          expect(result.reason.retryAfter).toBeLessThanOrEqual(5 * 60);
        }
      }
    });
    expect(await database.authRateLimit.count({ where: { scope: "SOURCE" } })).toBe(0);
    expect(await database.authRateLimit.count({ where: { scope: "GLOBAL" } })).toBe(1);
    const response = await unlock();
    expectPrivateResponse(response, 429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await database.authSession.count()).toBe(0);
  });

  it("atomically shares the trusted source budget across instances independently of caller-supplied XFF", async () => {
    setEnvironment("VERCEL", "1");
    await withIndependentInstance(async (other) => {
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? policy : other.policy).enforceUnlockRateLimit(mutationRequest("unlock", { headers: {
          "x-vercel-forwarded-for": "203.0.113.20", "x-forwarded-for": `198.51.100.${index + 1}`,
        } }), RATE_LIMIT_KEY),
      ));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ name: "PrivateAuthRateLimitError", retryAfter: expect.any(Number) });
          expect(result.reason.retryAfter).toBeGreaterThan(0);
          expect(result.reason.retryAfter).toBeLessThanOrEqual(15 * 60);
        }
      }
    });
    expect(await database.authRateLimit.count({ where: { scope: "SOURCE" } })).toBe(1);
    const serialized = JSON.stringify(await database.authRateLimit.findMany());
    expect(serialized).not.toContain("203.0.113.20");
    expect(serialized).not.toContain(RATE_LIMIT_KEY.toString("base64url"));
    await expect(policy.enforceUnlockRateLimit(mutationRequest("unlock", { headers: {
      "x-vercel-forwarded-for": "203.0.113.21",
    } }), RATE_LIMIT_KEY)).resolves.toEqual({ sourceLimitApplied: true });
  });

  it("uses global protection when the deployment source header is missing, malformed, or a list", async () => {
    setEnvironment("VERCEL", "1");
    for (const value of ["", "unknown", "203.0.113.4, 203.0.113.5", "203.0.113.4:8080"]) {
      await expect(policy.enforceUnlockRateLimit(mutationRequest("unlock", { headers: {
        "x-vercel-forwarded-for": value, "x-forwarded-for": "203.0.113.4",
      } }), RATE_LIMIT_KEY)).resolves.toEqual({ sourceLimitApplied: false });
    }
    expect(await database.authRateLimit.count({ where: { scope: "SOURCE" } })).toBe(0);
    expect(await database.authRateLimit.findFirst({ where: { scope: "GLOBAL" } })).toMatchObject({ attempts: 4 });
  });

  it("keeps a bounded cooldown under repeated traffic and permits attempts after persisted expiry", async () => {
    setEnvironment("VERCEL", "1");
    const request = () => mutationRequest("unlock", { headers: { "x-vercel-forwarded-for": "203.0.113.40" } });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await policy.enforceUnlockRateLimit(request(), RATE_LIMIT_KEY);
    }
    await expect(policy.enforceUnlockRateLimit(request(), RATE_LIMIT_KEY)).rejects.toMatchObject({ name: "PrivateAuthRateLimitError" });
    const before = await database.authRateLimit.findFirstOrThrow({ where: { scope: "SOURCE" } });
    expect(before.cooldownUntil).toEqual(before.windowExpiresAt);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(policy.enforceUnlockRateLimit(request(), RATE_LIMIT_KEY)).rejects.toMatchObject({ name: "PrivateAuthRateLimitError" });
    }
    const after = await database.authRateLimit.findFirstOrThrow({ where: { scope: "SOURCE" } });
    expect(after.cooldownUntil).toEqual(before.cooldownUntil);
    expect(after.attempts).toBe(before.attempts);
    await database.authRateLimit.updateMany({ data: {
      windowStartedAt: new Date(Date.now() - 120_000),
      windowExpiresAt: new Date(Date.now() - 60_000),
      cooldownUntil: new Date(Date.now() - 30_000),
      expiresAt: new Date(Date.now() - 30_000),
    } });
    await expect(policy.enforceUnlockRateLimit(request(), RATE_LIMIT_KEY)).resolves.toEqual({ sourceLimitApplied: true });
    for (const row of await database.authRateLimit.findMany()) {
      expect(row.attempts).toBe(1);
      expect(row.windowExpiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });
});
