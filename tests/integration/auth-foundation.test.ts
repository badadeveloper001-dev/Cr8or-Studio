import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// This suite must never fall back to DATABASE_URL, DIRECT_URL, or .env files.
// The deliberately narrow allowlist is the local disposable test service.
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
const schemaName = `auth_test_${randomBytes(8).toString("hex")}`;
const OWNER_FIXTURE = {
  id: "owner",
  // Intentionally invalid: these fixtures are not provisioned access credentials.
  accessCodeHash: "test-fixture-not-a-valid-encoded-access-code-hash",
  credentialVersion: 1,
  webAuthnUserHandle: randomBytes(32),
};
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousDirectUrl = process.env.DIRECT_URL;

describe.skipIf(!testUrl)("authentication foundation on isolated PostgreSQL", () => {
  let admin: PrismaClient;
  let database: PrismaClient;
  let sessions: typeof import("@/lib/security/session-store");
  let limits: typeof import("@/lib/security/auth-rate-limit");
  let legacySnapshot: unknown;

  async function applyMigration(directory: string) {
    const sql = await readFile(path.join(process.cwd(), "prisma/migrations", directory, "migration.sql"), "utf8");
    // These checked-in migrations contain ordinary DDL, without procedural SQL
    // or semicolons inside literals. Execute the actual historical statements.
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement && !/^(BEGIN|COMMIT)$/i.test(statement));
    await database.$transaction(async (transaction) => {
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    });
  }

  const snapshotLegacyProject = () => database.project.findUniqueOrThrow({
    where: { id: "existing-project" },
    include: { workspaces: true, tasks: true, globals: true, locals: true },
  });

  const newSession = (credentialVersion = 1) => sessions.createOwnerSession({
    credentialVersion,
    authenticationMethod: "ACCESS_CODE",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const identity = (scope: "SOURCE" | "GLOBAL" = "SOURCE") => ({
    scope,
    keyHash: randomBytes(32).toString("hex"),
  });

  async function withIndependentStores(run: (instance: {
    database: PrismaClient;
    sessions: typeof sessions;
    limits: typeof limits;
  }) => Promise<void>) {
    const savedGlobal = globalThis.prismaGlobal;
    const savedDatabaseUrl = process.env.DATABASE_URL;
    const savedDirectUrl = process.env.DIRECT_URL;
    const url = new URL(testUrl!);
    url.search = "";
    url.searchParams.set("schema", schemaName);
    // A dedicated single-connection pool also permits testing PostgreSQL session
    // timezone settings without changing any other client or database default.
    url.searchParams.set("connection_limit", "1");
    let independent: PrismaClient | undefined;
    vi.resetModules();
    delete globalThis.prismaGlobal;
    process.env.DATABASE_URL = url.toString();
    process.env.DIRECT_URL = url.toString();
    try {
      independent = (await import("@/lib/db/prisma")).prisma;
      const otherSessions = await import("@/lib/security/session-store");
      const otherLimits = await import("@/lib/security/auth-rate-limit");
      expect(independent).not.toBe(database);
      await run({ database: independent, sessions: otherSessions, limits: otherLimits });
    } finally {
      await independent?.$disconnect();
      if (savedGlobal === undefined) delete globalThis.prismaGlobal;
      else globalThis.prismaGlobal = savedGlobal;
      if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDatabaseUrl;
      if (savedDirectUrl === undefined) delete process.env.DIRECT_URL;
      else process.env.DIRECT_URL = savedDirectUrl;
    }
  }

  beforeAll(async () => {
    const url = new URL(testUrl!);
    // Do not retain a caller-supplied schema/search path.
    url.search = "";
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    url.searchParams.set("schema", schemaName);
    process.env.DATABASE_URL = url.toString();
    process.env.DIRECT_URL = url.toString();
    // These imports must occur only after both URLs have been replaced.
    database = (await import("@/lib/db/prisma")).prisma;
    sessions = await import("@/lib/security/session-store");
    limits = await import("@/lib/security/auth-rate-limit");

    await applyMigration("0_init");
    await applyMigration("20250101000000_add_workspace_table");
    await database.project.create({
      data: {
        id: "existing-project",
        name: "Existing project",
        description: "Preserved migration fixture",
        framework: "nextjs",
        language: "typescript",
        repository: "https://github.com/example/existing-project",
        workspaces: { create: {
          id: "existing-workspace",
          runtimeType: "cloud",
          provider: "daytona",
          providerWorkspaceId: "existing-provider-workspace",
          repositoryUrl: "https://github.com/example/existing-project",
          projectName: "Existing project",
          branch: "main",
          state: "ready",
        } },
        tasks: { create: { id: "existing-task", agentId: "builder", title: "Preserved task", status: "done", output: "stored output" } },
        globals: { create: { id: "existing-global-memory", key: "context", value: "stored context" } },
        locals: { create: { id: "existing-local-memory", agentId: "builder", note: "stored note" } },
      },
    });
    legacySnapshot = await snapshotLegacyProject();
    await applyMigration("20261015000000_authentication_foundation");
    expect(await database.ownerCredential.count()).toBe(0);
    expect(await database.authSession.count()).toBe(0);
  }, 30_000);

  beforeEach(async () => {
    await database.authSession.deleteMany();
    await database.ownerCredential.deleteMany();
    await database.authRateLimit.deleteMany();
    await database.ownerCredential.create({ data: OWNER_FIXTURE });
  });

  afterAll(async () => {
    try {
      await database?.$disconnect();
      if (admin) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin?.$disconnect();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousDirectUrl === undefined) delete process.env.DIRECT_URL;
      else process.env.DIRECT_URL = previousDirectUrl;
    }
  });

  it("preserves projects, workspace IDs, provider/GitHub references, tasks, and memories across the additive migration", async () => {
    expect(await snapshotLegacyProject()).toEqual(legacySnapshot);
  });

  it("enforces the singleton owner and stable 32-byte WebAuthn identity in PostgreSQL", async () => {
    await expect(database.ownerCredential.create({ data: { ...OWNER_FIXTURE, id: "second-owner", webAuthnUserHandle: randomBytes(32) } })).rejects.toThrow();
    await expect(database.ownerCredential.create({ data: { ...OWNER_FIXTURE, webAuthnUserHandle: randomBytes(32) } })).rejects.toMatchObject({ code: "P2002" });
    await expect(database.ownerCredential.update({ where: { id: "owner" }, data: { webAuthnUserHandle: randomBytes(31) } })).rejects.toThrow();
    await expect(database.ownerCredential.update({ where: { id: "owner" }, data: { credentialVersion: 0 } })).rejects.toThrow();
    expect(await database.ownerCredential.count()).toBe(1);
  });

  it("enforces session-token uniqueness and the owner foreign key", async () => {
    const { session } = await newSession();
    const stored = await database.authSession.findUniqueOrThrow({ where: { id: session.id } });
    await expect(database.authSession.create({ data: { ...stored, id: "duplicate-token" } })).rejects.toMatchObject({ code: "P2002" });
    await expect(database.authSession.create({ data: { ...stored, id: "missing-owner-session", ownerId: "missing-owner", tokenHash: randomBytes(32).toString("hex") } })).rejects.toMatchObject({ code: "P2003" });
    await expect(database.ownerCredential.delete({ where: { id: "owner" } })).rejects.toMatchObject({ code: "P2003" });
    await expect(database.authSession.update({ where: { id: session.id }, data: { tokenHash: "not-a-sha256-token-hash" } })).rejects.toThrow();
  });

  it("enforces rate-limit identity uniqueness, scope separation, and cleanup/lookup indexes", async () => {
    const source = identity();
    await limits.recordAuthAttempt({ ...source, windowMs: 60_000 });
    const stored = await database.authRateLimit.findUniqueOrThrow({ where: { scope_keyHash: source } });
    await expect(database.authRateLimit.create({ data: stored })).rejects.toMatchObject({ code: "P2002" });
    await database.authRateLimit.create({ data: { ...stored, scope: "GLOBAL" } });
    await expect(database.authRateLimit.update({ where: { scope_keyHash: source }, data: { attempts: -1 } })).rejects.toThrow();
    const indexes = await database.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ${schemaName}
    `;
    expect(indexes.map((index) => index.indexname)).toEqual(expect.arrayContaining([
      "OwnerCredential_webAuthnUserHandle_key",
      "AuthSession_tokenHash_key",
      "AuthSession_ownerId_revokedAt_idx",
      "AuthSession_expiresAt_idx",
      "AuthRateLimit_pkey",
      "AuthRateLimit_expiresAt_idx",
    ]));
    expect(indexes.find((index) => index.indexname === "AuthRateLimit_pkey")?.indexdef).toContain('UNIQUE INDEX');
  });

  it("denies authentication-table reads and writes to roles without an RLS bypass", async () => {
    await newSession();
    await limits.recordAuthAttempt({ ...identity(), windowMs: 60_000 });
    expect(await database.ownerCredential.count()).toBe(1);
    expect(await database.authSession.count()).toBe(1);
    expect(await database.authRateLimit.count()).toBe(1);

    const tables = await database.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT tables.relname, tables.relrowsecurity, tables.relforcerowsecurity
      FROM pg_class AS tables JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
      WHERE schemas.nspname = ${schemaName}
        AND tables.relname IN ('OwnerCredential', 'AuthSession', 'AuthRateLimit')
      ORDER BY tables.relname
    `;
    expect(tables).toEqual([
      { relname: "AuthRateLimit", relrowsecurity: true, relforcerowsecurity: false },
      { relname: "AuthSession", relrowsecurity: true, relforcerowsecurity: false },
      { relname: "OwnerCredential", relrowsecurity: true, relforcerowsecurity: false },
    ]);
    const policies = await database.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_policies
      WHERE schemaname = ${schemaName}
        AND tablename IN ('OwnerCredential', 'AuthSession', 'AuthRateLimit')
    `;
    expect(policies[0].count).toBe(0);

    // PostgreSQL's built-in roles have table/schema privileges but no BYPASSRLS.
    // SET LOCAL confines the role switch to this transaction and connection.
    const visible = await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL ROLE pg_read_all_data");
      return transaction.$queryRaw<Array<{ table: string; count: number }>>`
        SELECT 'OwnerCredential' AS "table", count(*)::integer AS count FROM "OwnerCredential"
        UNION ALL SELECT 'AuthSession', count(*)::integer FROM "AuthSession"
        UNION ALL SELECT 'AuthRateLimit', count(*)::integer FROM "AuthRateLimit"
      `;
    });
    expect(visible).toEqual([
      { table: "OwnerCredential", count: 0 },
      { table: "AuthSession", count: 0 },
      { table: "AuthRateLimit", count: 0 },
    ]);

    const blocked = identity();
    await expect(database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL ROLE pg_write_all_data");
      return transaction.$executeRaw`
        INSERT INTO "AuthRateLimit" (
          "scope", "keyHash", "attempts", "windowStartedAt", "windowExpiresAt",
          "expiresAt", "createdAt", "updatedAt"
        ) VALUES (
          ${blocked.scope}::"AuthRateLimitScope", ${blocked.keyHash}, 1,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 minute',
          CURRENT_TIMESTAMP + INTERVAL '1 minute', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;
    })).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "42501", message: expect.stringContaining("row-level security") },
    });
    expect(await database.authRateLimit.count()).toBe(1);
  });

  it("creates independent random 256-bit tokens and persists only SHA-256 digests", async () => {
    const created = await Promise.all(Array.from({ length: 12 }, () => newSession()));
    expect(new Set(created.map(({ token }) => token)).size).toBe(12);
    for (const { token, session } of created) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      const stored = await database.authSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(stored.tokenHash).toBe(sessions.hashSessionToken(token));
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(await sessions.resolveOwnerSession(token)).toMatchObject({ id: session.id, ownerId: "owner", credentialVersion: 1 });
      const resolved = await sessions.resolveSessionByTokenHash(stored.tokenHash);
      expect(resolved).toMatchObject({ id: session.id });
      expect(resolved).not.toHaveProperty("tokenHash");
      expect(resolved).not.toHaveProperty("accessCodeHash");
    }
  });

  it("accepts an expiration within 12 hours of the PostgreSQL authentication timestamp", async () => {
    const [clock] = await database.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"
    `;
    // Sampling first puts this just inside the limit when creation reads its
    // own database clock; the exact millisecond boundary is covered by unit tests.
    const expiresAt = new Date(clock.now.getTime() + 12 * 60 * 60 * 1000);
    const { token, session } = await sessions.createOwnerSession({
      credentialVersion: 1,
      authenticationMethod: "ACCESS_CODE",
      expiresAt,
    });
    const stored = await database.authSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(stored.expiresAt).toEqual(expiresAt);
    expect(stored.authenticatedAt.getTime()).toBeGreaterThanOrEqual(clock.now.getTime());
    expect(stored.expiresAt.getTime() - stored.authenticatedAt.getTime()).toBeGreaterThan(0);
    expect(stored.expiresAt.getTime() - stored.authenticatedAt.getTime()).toBeLessThanOrEqual(12 * 60 * 60 * 1000);
    expect(await sessions.resolveOwnerSession(token)).toMatchObject({ id: session.id });
  });

  it("rejects a requested 13-hour session without persisting a token digest", async () => {
    const [clock] = await database.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"
    `;
    await expect(sessions.createOwnerSession({
      credentialVersion: 1,
      authenticationMethod: "ACCESS_CODE",
      expiresAt: new Date(clock.now.getTime() + 13 * 60 * 60 * 1000),
    })).rejects.toMatchObject({ name: "SessionStoreError", code: "INVALID_EXPIRATION" });
    expect(await database.authSession.count()).toBe(0);
  });

  it("rejects an already expired session using the PostgreSQL clock", async () => {
    const [clock] = await database.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"
    `;
    await expect(sessions.createOwnerSession({
      credentialVersion: 1,
      authenticationMethod: "ACCESS_CODE",
      expiresAt: new Date(clock.now.getTime() - 60_000),
    })).rejects.toMatchObject({ name: "SessionStoreError", code: "INVALID_EXPIRATION" });
    expect(await database.authSession.count()).toBe(0);
  });

  it("rejects an invalid expiration value without creating a session", async () => {
    await expect(sessions.createOwnerSession({
      credentialVersion: 1,
      authenticationMethod: "ACCESS_CODE",
      expiresAt: new Date(Number.NaN),
    })).rejects.toBeInstanceOf(TypeError);
    expect(await database.authSession.count()).toBe(0);
  });

  it("rejects unknown, expired, revoked, and obsolete-version sessions without cached authorization", async () => {
    const { token, session } = await newSession();
    expect(await sessions.resolveOwnerSession(randomBytes(32).toString("base64url"))).toBeNull();
    expect(await sessions.resolveOwnerSession(token)).not.toBeNull();
    await database.authSession.update({ where: { id: session.id }, data: {
      authenticatedAt: new Date(Date.now() - 120_000),
      createdAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
    } });
    expect(await sessions.resolveOwnerSession(token)).toBeNull();

    const revoked = await newSession();
    expect(await sessions.revokeSession(revoked.session.id)).toBe(1);
    expect(await sessions.resolveOwnerSession(revoked.token)).toBeNull();
    expect(await sessions.revokeSession(revoked.session.id)).toBe(0);

    const obsolete = await newSession();
    await database.ownerCredential.update({ where: { id: "owner" }, data: { credentialVersion: { increment: 1 } } });
    expect(await sessions.resolveOwnerSession(obsolete.token)).toBeNull();
    await expect(newSession(1)).rejects.toThrow();
    const current = await newSession(2);
    expect(await sessions.resolveOwnerSession(current.token)).not.toBeNull();
  });

  it("revokes one device independently and invalidates every existing device on revoke-all", async () => {
    const first = await newSession();
    const second = await newSession();
    await sessions.revokeSession(first.session.id);
    expect(await sessions.resolveOwnerSession(first.token)).toBeNull();
    expect(await sessions.resolveOwnerSession(second.token)).not.toBeNull();
    expect(await sessions.revokeAllOwnerSessions()).toEqual({ revokedCount: 1, credentialVersion: 2 });
    expect(await sessions.resolveOwnerSession(second.token)).toBeNull();
    await expect(newSession(1)).rejects.toThrow();
    expect(await sessions.resolveOwnerSession((await newSession(2)).token)).not.toBeNull();
  });

  it("serializes session creation against credential rotation holding the owner row lock", async () => {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let releaseRotation!: () => void;
    const release = new Promise<void>((resolve) => { releaseRotation = resolve; });
    const rotation = database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "OwnerCredential" WHERE "id" = 'owner' FOR UPDATE`;
      signalLocked();
      await release;
      await transaction.ownerCredential.update({ where: { id: "owner" }, data: { credentialVersion: { increment: 1 } } });
      await transaction.authSession.updateMany({ where: { ownerId: "owner", revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await locked;
    const pendingCreation = newSession(1);
    const rejected = expect(pendingCreation).rejects.toThrow();
    releaseRotation();
    await rotation;
    await rejected;
    expect(await database.authSession.count({ where: { credentialVersion: 1, revokedAt: null } })).toBe(0);
  });

  it("leaves no old-version session valid when create races with global revocation", async () => {
    const existing = await newSession();
    const results = await Promise.allSettled([
      ...Array.from({ length: 8 }, () => newSession(1)),
      sessions.revokeAllOwnerSessions(),
    ]);
    expect(results.at(-1)?.status).toBe("fulfilled");
    expect(await sessions.resolveOwnerSession(existing.token)).toBeNull();
    for (const result of results.slice(0, -1)) {
      if (result.status === "fulfilled" && "token" in result.value) {
        expect(await sessions.resolveOwnerSession(result.value.token)).toBeNull();
      }
    }
  });

  it("cleans only expired sessions and retains unexpired device sessions", async () => {
    const expired = await newSession();
    const active = await newSession();
    await database.authSession.update({ where: { id: expired.session.id }, data: {
      authenticatedAt: new Date(Date.now() - 120_000),
      createdAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
    } });
    expect(await sessions.cleanupExpiredSessions()).toBe(1);
    expect(await database.authSession.findUnique({ where: { id: expired.session.id } })).toBeNull();
    expect(await sessions.resolveOwnerSession(active.token)).not.toBeNull();
  });

  it("counts concurrent requests atomically and independently for source/global scopes", async () => {
    const source = identity();
    const states = await Promise.all(Array.from({ length: 30 }, () => limits.recordAuthAttempt({ ...source, windowMs: 60_000 })));
    expect(states.map((state) => state.attempts).sort((left, right) => left - right)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(await limits.getAuthRateLimit(source)).toMatchObject({ attempts: 30, windowExpired: false, coolingDown: false });
    expect(await limits.recordAuthAttempt({ ...source, scope: "GLOBAL", windowMs: 60_000 })).toMatchObject({ attempts: 1 });
  });

  it("shares atomic counts and immediately observes revocation/expiry across independent application instances", async () => {
    const source = identity();
    const created = await newSession();
    await withIndependentStores(async (other) => {
      expect(await other.sessions.resolveOwnerSession(created.token)).not.toBeNull();
      await Promise.all(Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? limits : other.limits).recordAuthAttempt({ ...source, windowMs: 60_000 }),
      ));
      expect(await limits.getAuthRateLimit(source)).toMatchObject({ attempts: 20 });
      expect(await other.limits.getAuthRateLimit(source)).toMatchObject({ attempts: 20 });
      await sessions.revokeSession(created.session.id);
      expect(await other.sessions.resolveOwnerSession(created.token)).toBeNull();

      const another = await other.sessions.createOwnerSession({
        credentialVersion: 1,
        authenticationMethod: "ACCESS_CODE",
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await sessions.resolveOwnerSession(another.token)).not.toBeNull();
      await database.authSession.update({ where: { id: another.session.id }, data: {
        authenticatedAt: new Date(Date.now() - 120_000),
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      } });
      expect(await other.sessions.resolveOwnerSession(another.token)).toBeNull();
      expect(await sessions.resolveOwnerSession(another.token)).toBeNull();
    });
  });

  it("uses UTC for session validity, revocation, cooldowns, and cleanup regardless of database session timezone", async () => {
    await withIndependentStores(async (other) => {
      await other.database.$executeRawUnsafe("SET TIME ZONE 'Pacific/Honolulu'");
      const timezone = await other.database.$queryRaw<Array<{ TimeZone: string }>>`SHOW TIME ZONE`;
      expect(timezone[0].TimeZone).toBe("Pacific/Honolulu");
      const created = await other.sessions.createOwnerSession({
        credentialVersion: 1,
        authenticationMethod: "ACCESS_CODE",
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(Math.abs(created.session.createdAt.getTime() - Date.now())).toBeLessThan(5_000);
      expect(await sessions.resolveOwnerSession(created.token)).not.toBeNull();
      expect(await other.sessions.resolveOwnerSession(created.token)).not.toBeNull();
      await other.sessions.revokeSession(created.session.id);
      const revoked = await database.authSession.findUniqueOrThrow({ where: { id: created.session.id } });
      expect(Math.abs(revoked.revokedAt!.getTime() - Date.now())).toBeLessThan(5_000);
      expect(await sessions.resolveOwnerSession(created.token)).toBeNull();
      await database.authSession.update({ where: { id: created.session.id }, data: {
        authenticatedAt: new Date(Date.now() - 120_000),
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      } });
      expect(await other.sessions.cleanupExpiredSessions()).toBe(1);

      const source = identity();
      const initial = await other.limits.recordAuthAttempt({ ...source, windowMs: 60_000 });
      expect(Math.abs(initial.windowStartedAt.getTime() - Date.now())).toBeLessThan(5_000);
      const cooled = await other.limits.applyAuthCooldown({ ...source, windowStartedAt: initial.windowStartedAt, durationMs: 120_000 });
      expect(cooled).toMatchObject({ coolingDown: true, windowExpired: false });
      expect(await limits.getAuthRateLimit(source)).toMatchObject({ coolingDown: true, windowExpired: false });
      await database.authRateLimit.update({ where: { scope_keyHash: source }, data: {
        windowStartedAt: new Date(Date.now() - 120_000),
        windowExpiresAt: new Date(Date.now() - 60_000),
        cooldownUntil: new Date(Date.now() - 30_000),
        expiresAt: new Date(Date.now() - 30_000),
      } });
      expect(await other.limits.getAuthRateLimit(source)).toMatchObject({ coolingDown: false, windowExpired: true });
      expect(await other.limits.cleanupExpiredAuthRateLimits()).toBe(1);
    });
  });

  it("starts a new window after expiration and rejects stale cooldown updates", async () => {
    const source = identity();
    await limits.recordAuthAttempt({ ...source, windowMs: 60_000 });
    const expiredStart = new Date(Date.now() - 120_000);
    await database.authRateLimit.update({ where: { scope_keyHash: source }, data: {
      windowStartedAt: expiredStart,
      windowExpiresAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    } });
    expect(await limits.getAuthRateLimit(source)).toMatchObject({ windowExpired: true });
    expect(await limits.applyAuthCooldown({ ...source, windowStartedAt: expiredStart, durationMs: 60_000 })).toBeNull();
    const current = await limits.recordAuthAttempt({ ...source, windowMs: 60_000 });
    expect(current).toMatchObject({ attempts: 1, windowExpired: false });
    expect(current.windowStartedAt.getTime()).toBeGreaterThan(expiredStart.getTime());
    expect(await limits.applyAuthCooldown({ ...source, windowStartedAt: expiredStart, durationMs: 60_000 })).toBeNull();
    expect(await limits.getAuthRateLimit(source)).toMatchObject({ coolingDown: false });
  });

  it("persists cooldown across expired windows and retains it during cleanup", async () => {
    const source = identity();
    const initial = await limits.recordAuthAttempt({ ...source, windowMs: 60_000 });
    const cooled = await limits.applyAuthCooldown({ ...source, windowStartedAt: initial.windowStartedAt, durationMs: 120_000 });
    expect(cooled).toMatchObject({ coolingDown: true });
    expect(cooled?.cooldownUntil).toBeInstanceOf(Date);
    await database.authRateLimit.update({ where: { scope_keyHash: source }, data: {
      windowStartedAt: new Date(Date.now() - 120_000),
      windowExpiresAt: new Date(Date.now() - 60_000),
    } });
    expect(await limits.cleanupExpiredAuthRateLimits()).toBe(0);
    const reset = await limits.recordAuthAttempt({ ...source, windowMs: 60_000 });
    expect(reset).toMatchObject({ attempts: 1, coolingDown: true });
    expect(reset.cooldownUntil).toEqual(cooled?.cooldownUntil);
    expect(await limits.getAuthRateLimit(source)).toMatchObject({ coolingDown: true });
  });

  it("never shortens a cooldown when concurrent policy decisions race", async () => {
    const source = identity("GLOBAL");
    const initial = await limits.recordAuthAttempt({ ...source, windowMs: 60_000 });
    const decisions = await Promise.all([120_000, 20_000, 90_000, 5_000].map((durationMs) =>
      limits.applyAuthCooldown({ ...source, windowStartedAt: initial.windowStartedAt, durationMs }),
    ));
    const longest = Math.max(...decisions.map((state) => state!.cooldownUntil!.getTime()));
    const current = await limits.getAuthRateLimit(source);
    expect(current?.cooldownUntil?.getTime()).toBe(longest);
    expect(current?.expiresAt.getTime()).toBeGreaterThanOrEqual(longest);
  });

  it("cleans expired rate records and permits a later attempt without permanent lockout", async () => {
    const source = identity();
    await limits.recordAuthAttempt({ ...source, windowMs: 60_000 });
    await database.authRateLimit.update({ where: { scope_keyHash: source }, data: {
      windowStartedAt: new Date(Date.now() - 120_000),
      windowExpiresAt: new Date(Date.now() - 60_000),
      cooldownUntil: new Date(Date.now() - 30_000),
      expiresAt: new Date(Date.now() - 30_000),
    } });
    expect(await limits.cleanupExpiredAuthRateLimits()).toBe(1);
    expect(await limits.getAuthRateLimit(source)).toBeNull();
    expect(await limits.recordAuthAttempt({ ...source, windowMs: 60_000 })).toMatchObject({ attempts: 1, coolingDown: false });
  });

  it("fails closed when required persistence tables are unavailable", async () => {
    const session = await newSession();
    await database.$executeRawUnsafe('ALTER TABLE "AuthSession" RENAME TO "AuthSessionUnavailable"');
    try {
      await expect(sessions.resolveOwnerSession(session.token)).rejects.toThrow();
      await expect(newSession()).rejects.toThrow();
    } finally {
      await database.$executeRawUnsafe('ALTER TABLE "AuthSessionUnavailable" RENAME TO "AuthSession"');
    }
    await database.$executeRawUnsafe('ALTER TABLE "AuthRateLimit" RENAME TO "AuthRateLimitUnavailable"');
    try {
      await expect(limits.recordAuthAttempt({ ...identity(), windowMs: 60_000 })).rejects.toThrow();
      await expect(limits.getAuthRateLimit(identity())).rejects.toThrow();
    } finally {
      await database.$executeRawUnsafe('ALTER TABLE "AuthRateLimitUnavailable" RENAME TO "AuthRateLimit"');
    }
  });
});
