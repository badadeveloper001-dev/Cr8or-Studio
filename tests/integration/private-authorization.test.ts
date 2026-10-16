import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient, type OwnerCredential } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Never select a service from DATABASE_URL, DIRECT_URL, or a .env file. Each
// explicitly selected disposable local database run owns a separate schema.
function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== "55432" || url.pathname !== "/cr8or_auth_test"
  ) {
    throw new Error("Authorization integration tests require the isolated local test database on port 55432.");
  }
  return url;
}

const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const schemaName = `private_authorization_test_${randomBytes(8).toString("hex")}`;
const ORIGIN = "http://localhost:3000";
// Public, synthetic values used only in the disposable schema.
const ACCESS_CODE = "1234";
const NEXT_ACCESS_CODE = "7";
const PROJECT_ID = "existing-project-fixture";
const WORKSPACE_ID = "existing-workspace-fixture";
const PROVIDER_WORKSPACE_ID = "existing-daytona-workspace-fixture";
const RATE_LIMIT_KEY = randomBytes(32).toString("base64url");
const CLAIMED_IDENTITY_HEADERS: Record<string, string>[] = [
  { authorization: "Bearer synthetic-legacy-token" },
  { "x-cr8or-token": "synthetic-legacy-token" },
  { authorization: "Bearer synthetic-supabase-token" },
  { "x-owner-id": "owner", "x-session-id": "claimed-session", "x-user-id": "local-dev", "x-role": "owner" },
];
const ENVIRONMENT_KEYS = [
  "DATABASE_URL", "DIRECT_URL", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL",
  "VERCEL_DEPLOYMENT_ID", "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN",
  "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", "CR8OR_FEATURE_AUTH_GUARD", "CR8OR_DEV_API_TOKEN",
  "CR8OR_DEV_USER_ID", "CR8OR_OWNER_IDS", "CR8OR_WORKSPACE_OWNERS_JSON", "CR8OR_FEATURE_AUDIT_LOG",
] as const;
const previousEnvironment = new Map(ENVIRONMENT_KEYS.map((name) => [name, process.env[name]]));
const previousGlobal = globalThis.prismaGlobal;

function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe.skipIf(!testUrl)("private API authorization on isolated PostgreSQL", () => {
  let admin: PrismaClient;
  let database: PrismaClient;
  let ownerFixture: OwnerCredential;
  let owners: typeof import("@/lib/security/owner-management");
  let sessions: typeof import("@/lib/security/session-store");
  let authorization: typeof import("@/lib/security/authorization");
  let middleware: typeof import("@/middleware");
  let projectsRoute: typeof import("@/app/api/projects/route");
  let unlockRoute: typeof import("@/app/api/auth/unlock/route");
  let sessionRoute: typeof import("@/app/api/auth/session/route");
  let lockRoute: typeof import("@/app/api/auth/lock/route");
  let chatRoute: typeof import("@/app/api/chat/main/route");
  let orchestrationRoute: typeof import("@/app/api/orchestrate/route");
  let streamRoute: typeof import("@/app/api/orchestrate/stream/route");

  function enablePrivateAuth() {
    setEnvironment("NODE_ENV", "test");
    for (const name of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) {
      setEnvironment(name, undefined);
    }
    setEnvironment("CR8OR_PRIVATE_AUTH_ENABLED", "true");
    setEnvironment("CR8OR_PRIVATE_AUTH_ORIGIN", ORIGIN);
    setEnvironment("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", RATE_LIMIT_KEY);
    // Private mode must remain mandatory even when the legacy guard is disabled.
    setEnvironment("CR8OR_FEATURE_AUTH_GUARD", "false");
    setEnvironment("CR8OR_FEATURE_AUDIT_LOG", "false");
    setEnvironment("CR8OR_DEV_API_TOKEN", "synthetic-legacy-token");
    setEnvironment("CR8OR_DEV_USER_ID", "local-dev");
    setEnvironment("CR8OR_OWNER_IDS", "local-dev,claimed-owner");
    setEnvironment("CR8OR_WORKSPACE_OWNERS_JSON", JSON.stringify({ [WORKSPACE_ID]: ["claimed-owner"] }));
  }

  function request(endpoint = "/api/projects", options: {
    method?: string;
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}) {
    const method = options.method ?? "GET";
    return new NextRequest(`${ORIGIN}${endpoint}`, {
      method,
      headers: {
        ...(method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
          ? { origin: ORIGIN, "x-cr8or-auth": "1", "content-type": "application/json" } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  }

  function expectResponse(response: Response, status: number) {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  function expectPassedMiddleware(response: Response) {
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  async function createSessionCookie() {
    const { token, session } = await sessions.createOwnerSession({
      credentialVersion: ownerFixture.credentialVersion,
      authenticationMethod: "ACCESS_CODE",
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    return { cookie: `cr8or-dev-session=${token}`, session };
  }

  async function unlock(accessCode = ACCESS_CODE) {
    const response = await unlockRoute.POST(request("/api/auth/unlock", {
      method: "POST", body: { accessCode },
    }));
    expectResponse(response, 200);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    return { cookie: setCookie!.split(";", 1)[0], response };
  }

  async function applyMigration(directory: string) {
    const sql = await readFile(path.join(process.cwd(), "prisma/migrations", directory, "migration.sql"), "utf8");
    // Existing migrations contain ordinary DDL without semicolons in literals.
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement && !/^(BEGIN|COMMIT)$/i.test(statement));
    await database.$transaction(async (transaction) => {
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    });
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
    database = (await import("@/lib/db/prisma")).prisma;
    for (const migration of ["0_init", "20250101000000_add_workspace_table", "20261015000000_authentication_foundation"]) {
      await applyMigration(migration);
    }
    owners = await import("@/lib/security/owner-management");
    sessions = await import("@/lib/security/session-store");
    authorization = await import("@/lib/security/authorization");
    middleware = await import("@/middleware");
    projectsRoute = await import("@/app/api/projects/route");
    unlockRoute = await import("@/app/api/auth/unlock/route");
    sessionRoute = await import("@/app/api/auth/session/route");
    lockRoute = await import("@/app/api/auth/lock/route");
    chatRoute = await import("@/app/api/chat/main/route");
    orchestrationRoute = await import("@/app/api/orchestrate/route");
    streamRoute = await import("@/app/api/orchestrate/stream/route");
    await owners.provisionOwner(ACCESS_CODE);
    ownerFixture = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    await database.project.create({ data: {
      id: PROJECT_ID, name: "Existing isolated project", description: "Preserved fixture",
      framework: "Next.js", language: "TypeScript", repository: "https://github.com/example/synthetic-project",
      workspaces: { create: {
        id: WORKSPACE_ID, runtimeType: "cloud", provider: "daytona", providerWorkspaceId: PROVIDER_WORKSPACE_ID,
        repositoryUrl: "https://github.com/example/synthetic-project", branch: "main", state: "running",
      } },
      tasks: { create: { id: "existing-task-fixture", agentId: "fixture", title: "Stored task", status: "completed" } },
      globals: { create: { id: "existing-memory-fixture", key: "fixture", value: "Stored memory" } },
    } });
  }, 30_000);

  beforeEach(async () => {
    enablePrivateAuth();
    await database.authSession.deleteMany();
    await database.ownerCredential.deleteMany();
    await database.authRateLimit.deleteMany();
    await database.ownerCredential.create({ data: ownerFixture });
    await database.project.deleteMany({ where: { id: { not: PROJECT_ID } } });
  });

  afterEach(() => vi.restoreAllMocks());

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

  it.each([
    ["missing", undefined],
    ["malformed", "cr8or-dev-session=not-a-session"],
    ["forged", `cr8or-dev-session=${randomBytes(32).toString("base64url")}`],
    ["arbitrary owner identifier", "cr8or-dev-session=owner"],
  ])("rejects a %s cookie in middleware and the handler before querying projects", async (_label, cookie) => {
    const readProjects = vi.spyOn(database.project, "findMany");
    expectResponse(await middleware.middleware(request("/api/projects", { cookie })), 401);
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie })), 401);
    expect(readProjects).not.toHaveBeenCalled();
  });

  it.each(["expired", "revoked", "obsolete credential version"] as const)("rejects a %s database session", async (state) => {
    const { cookie, session } = await createSessionCookie();
    if (state === "expired") {
      await database.authSession.update({ where: { id: session.id }, data: {
        authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      } });
    } else if (state === "revoked") {
      await sessions.revokeSession(session.id);
    } else {
      await database.ownerCredential.update({ where: { id: "owner" }, data: { credentialVersion: { increment: 1 } } });
    }
    const readProjects = vi.spyOn(database.project, "findMany");
    expectResponse(await middleware.middleware(request("/api/projects", { cookie })), 401);
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie })), 401);
    expect(readProjects).not.toHaveBeenCalled();
  });

  it.each(CLAIMED_IDENTITY_HEADERS)("rejects legacy or client-claimed identity headers %# with the old guard disabled", async (headers) => {
    expectResponse(await middleware.middleware(request("/api/projects", { headers })), 401);
    expectResponse(await projectsRoute.GET(request("/api/projects", { headers })), 401);
  });

  it("does not accept a client-supplied internal session ID or a duplicated session cookie", async () => {
    const { cookie, session } = await createSessionCookie();
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie: `cr8or-dev-session=${session.id}` })), 401);
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie: `${cookie}; ${cookie}` })), 401);
  });

  it("rejects unauthenticated writes before parsing or creating project records", async () => {
    const write = request("/api/projects", { method: "POST", body: { name: "Unauthorized project" } });
    const readBody = vi.spyOn(write, "json");
    const createProject = vi.spyOn(database.project, "create");
    expectResponse(await projectsRoute.POST(write), 401);
    expect(readBody).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
    expect(await database.project.count()).toBe(1);
  });

  it.each([
    ["CR8OR_PRIVATE_AUTH_ENABLED", undefined],
    ["CR8OR_PRIVATE_AUTH_ENABLED", "false"],
    ["CR8OR_PRIVATE_AUTH_ENABLED", ""],
    ["CR8OR_PRIVATE_AUTH_ENABLED", "TRUE"],
    ["CR8OR_PRIVATE_AUTH_ENABLED", "invalid"],
    ["CR8OR_PRIVATE_AUTH_ORIGIN", undefined],
    ["CR8OR_PRIVATE_AUTH_ORIGIN", "https://example.invalid/path"],
    ["CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", undefined],
    ["CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", "invalid"],
  ] as const)("fails closed for invalid %s configuration %# even with an existing valid session", async (name, value) => {
    const { cookie } = await createSessionCookie();
    setEnvironment(name, value);
    const readProjects = vi.spyOn(database.project, "findMany");
    expectResponse(await middleware.middleware(request("/api/projects", { cookie })), 503);
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie })), 503);
    expect(readProjects).not.toHaveBeenCalled();
  });

  it("fails closed on session database failure without querying or creating projects", async () => {
    const { cookie } = await createSessionCookie();
    const readProjects = vi.spyOn(database.project, "findMany");
    const createProject = vi.spyOn(database.project, "create");
    await database.$executeRawUnsafe('ALTER TABLE "AuthSession" RENAME TO "AuthSessionUnavailable"');
    try {
      expectResponse(await middleware.middleware(request("/api/projects", { cookie })), 503);
      expectResponse(await projectsRoute.GET(request("/api/projects", { cookie })), 503);
      expectResponse(await projectsRoute.POST(request("/api/projects", {
        method: "POST", cookie, body: { name: "Must not be created" },
      })), 503);
      expect(readProjects).not.toHaveBeenCalled();
      expect(createProject).not.toHaveBeenCalled();
    } finally {
      await database.$executeRawUnsafe('ALTER TABLE "AuthSessionUnavailable" RENAME TO "AuthSession"');
    }
  });

  it("revalidates in the protected handler after middleware passed, even for the same request object", async () => {
    const { cookie, session } = await createSessionCookie();
    const incoming = request("/api/projects", { cookie });
    expectPassedMiddleware(await middleware.middleware(incoming));
    await sessions.revokeSession(session.id);
    const readProjects = vi.spyOn(database.project, "findMany");
    expectResponse(await projectsRoute.GET(incoming), 401);
    expect(readProjects).not.toHaveBeenCalled();
  });

  it("resolves only the verified singleton owner and preserves existing project and workspace identifiers", async () => {
    const { cookie } = await createSessionCookie();
    const incoming = request("/api/projects", { cookie, headers: {
      "x-owner-id": "claimed-owner", "x-role": "viewer", "x-user-id": "local-dev",
    } });
    const result = await authorization.authorizeRoute(incoming, {
      route: "integration/existing-workspace", minRole: "owner",
      requireWorkspaceOwnership: true, workspaceId: WORKSPACE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a verified owner session.");
    expect(result.session).toMatchObject({ userId: "owner", role: "owner", authenticated: true });
    const response = await projectsRoute.GET(incoming);
    expectResponse(response, 200);
    expect(await response.json()).toEqual([expect.objectContaining({ id: PROJECT_ID, name: "Existing isolated project" })]);
    expect(await database.workspace.findUnique({ where: { id: WORKSPACE_ID } })).toMatchObject({
      id: WORKSPACE_ID, projectId: PROJECT_ID, provider: "daytona", providerWorkspaceId: PROVIDER_WORKSPACE_ID,
      repositoryUrl: "https://github.com/example/synthetic-project", branch: "main",
    });
    expect(await database.task.count({ where: { projectId: PROJECT_ID } })).toBe(1);
    expect(await database.globalMemory.count({ where: { projectId: PROJECT_ID } })).toBe(1);
  });

  it("allows an authenticated same-origin project write", async () => {
    const { cookie } = await createSessionCookie();
    const response = await projectsRoute.POST(request("/api/projects", {
      method: "POST", cookie, body: { name: "Authorized isolated project" },
    }));
    expectResponse(response, 201);
    expect(await database.project.count()).toBe(2);
  });

  it.each(["missing origin", "foreign origin", "missing request header", "cross-site request"] as const)(
    "rejects an authenticated protected mutation with %s before database writes", async (condition) => {
      const { cookie } = await createSessionCookie();
      const incoming = request("/api/projects", {
        method: "POST", cookie, body: { name: "Must not be created" },
      });
      if (condition === "missing origin") incoming.headers.delete("origin");
      if (condition === "foreign origin") incoming.headers.set("origin", "https://untrusted.invalid");
      if (condition === "missing request header") incoming.headers.delete("x-cr8or-auth");
      if (condition === "cross-site request") incoming.headers.set("sec-fetch-site", "cross-site");
      const createProject = vi.spyOn(database.project, "create");
      expectResponse(await middleware.middleware(incoming), 400);
      expectResponse(await projectsRoute.POST(incoming), 400);
      expect(createProject).not.toHaveBeenCalled();
    },
  );

  it("allows short-code unlock, protected access, and lock without exposing sensitive session metadata", async () => {
    expectPassedMiddleware(await middleware.middleware(request("/api/auth/unlock", {
      method: "POST", body: { accessCode: ACCESS_CODE },
    })));
    const { cookie, response } = await unlock();
    expect(await response.json()).toEqual({ ok: true, authenticated: true, expiresAt: expect.any(String) });
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie })), 200);
    expectPassedMiddleware(await middleware.middleware(request("/api/auth/lock", { method: "POST", cookie })));
    expectResponse(await lockRoute.POST(request("/api/auth/lock", { method: "POST", cookie })), 204);
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie })), 401);
  });

  it("rejects previously unlocked sessions after credential rotation and accepts the rotated short code", async () => {
    const { cookie } = await unlock();
    await owners.rotateOwnerAccessCode(NEXT_ACCESS_CODE);
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie })), 401);
    const rotated = await unlock(NEXT_ACCESS_CODE);
    expectResponse(await projectsRoute.GET(request("/api/projects", { cookie: rotated.cookie })), 200);
  });

  it("keeps only exact authentication paths and supported methods public", async () => {
    expectPassedMiddleware(await middleware.middleware(request("/api/auth/session")));
    const status = await sessionRoute.GET(request("/api/auth/session"));
    expectResponse(status, 200);
    expect(await status.json()).toEqual({ ok: true, authenticated: false });
    expectPassedMiddleware(await middleware.middleware(request("/api/auth/lock", { method: "POST" })));
    expectResponse(await lockRoute.POST(request("/api/auth/lock", { method: "POST" })), 204);
    for (const endpoint of ["/api/auth/setup", "/api/auth/session/extra", "/api/auth/unlock/extra"]) {
      expectResponse(await middleware.middleware(request(endpoint)), 401);
    }
    const wrongMethod = await middleware.middleware(request("/api/auth/unlock"));
    expectResponse(wrongMethod, 405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expectResponse(await middleware.middleware(request("/api/projects", { method: "OPTIONS" })), 401);
    expectResponse(await projectsRoute.OPTIONS(request("/api/projects", { method: "OPTIONS" })), 401);
  });

  it("blocks incomplete agent execution paths even after real owner authentication", async () => {
    const { cookie } = await createSessionCookie();
    for (const [endpoint, handler] of [
      ["/api/chat/main", chatRoute.POST],
      ["/api/orchestrate", orchestrationRoute.POST],
      ["/api/orchestrate/stream", streamRoute.POST],
    ] as const) {
      const incoming = request(endpoint, { method: "POST", cookie, body: {
        projectId: PROJECT_ID, prompt: "Synthetic execution request", message: "Read package.json",
      } });
      const parseBody = vi.spyOn(incoming, "json");
      expectResponse(await handler(incoming), 503);
      expect(parseBody).not.toHaveBeenCalled();
    }
  });
});
