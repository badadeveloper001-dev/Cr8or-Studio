import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PrismaClient, type OwnerCredential } from "@prisma/client";
import type { Process, Sandbox } from "@daytona/sdk";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ToolContext } from "@/lib/agents/tools";
import type { ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { createControlledDaytonaSessionAdapter, type ControlledDaytonaSessionAdapter } from "../helpers/daytona-session-adapter";

vi.mock("server-only", () => ({}));
// Provider methods below use controlled local adapters. Do not construct an SDK
// client with background networking while exercising the real runtime factory.
vi.mock("@daytona/sdk", () => ({ Daytona: class {} }));
// This test-only substitution exercises the implemented protocol through actual
// handlers/runtimes. It does not enable deployed writes or mock authentication.
vi.mock("@/lib/workspace/private-cloud-write-availability", () => ({
  assertPrivateCloudWriteTransportAvailable: vi.fn(),
}));

function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "55432" || url.pathname !== "/cr8or_auth_test") {
    throw new Error("Cloud write tests require the isolated local test database on port 55432.");
  }
  return url;
}

const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const suffix = randomBytes(8).toString("hex");
const schemaName = `cloud_write_authorization_${suffix}`;
const PROJECT_ID = `cloud-write-fixture-${suffix}`;
const SANDBOX_ID = `registered-sandbox-${suffix}`;
const ORIGINAL = "original synthetic source\n";
const ORIGIN = "http://localhost:3000";
const environmentKeys = [
  "DATABASE_URL", "DIRECT_URL", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID",
  "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY",
  "CR8OR_FEATURE_AUTH_GUARD", "CR8OR_FEATURE_AUDIT_LOG", "CR8OR_WORKSPACE_MODE", "CR8OR_POLICY_PROFILE",
  "DAYTONA_API_KEY", "DAYTONA_API_URL",
] as const;
const previousEnvironment = new Map(environmentKeys.map((name) => [name, process.env[name]]));
const previousGlobal = globalThis.prismaGlobal;
const previousPolicy = globalThis.__cr8orPolicyStore;

function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// Every row and file is disposable. There is no DATABASE_URL fallback or dotenv
// loading. The SDK-shaped adapter runs the real Python helper locally; these
// tests establish application/protocol behavior, not live Daytona compatibility.
describe.skipIf(!testUrl)("cloud write authorization on isolated PostgreSQL", () => {
  let admin: PrismaClient;
  let database: PrismaClient;
  let ownerFixture: OwnerCredential;
  let root: string;
  let adapter: ControlledDaytonaSessionAdapter;
  let sandboxLookup: Mock<(id: string) => Promise<Sandbox | null>>;
  let sessionProcessLookup: Mock<(id: string) => Promise<Process>>;
  let auth: typeof import("@/lib/security/auth");
  let sessions: typeof import("@/lib/security/session-store");
  let owners: typeof import("@/lib/security/owner-management");
  let execution: typeof import("@/lib/security/execution-context");
  let runtimes: typeof import("@/lib/workspace/runtime-factory");
  let cloudFiles: typeof import("@/lib/workspace/private-cloud-write-session");
  let providerModule: typeof import("@/lib/workspace/providers/daytona");
  let tools: typeof import("@/lib/agents/tool-executor");
  let policy: typeof import("@/lib/security/policy");
  let filesRoute: typeof import("@/app/api/files/route");

  function request(cookie?: string, body?: unknown, origin = ORIGIN) {
    return new NextRequest(`${ORIGIN}/api/files`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(cookie ? { cookie } : {}), origin,
        "x-cr8or-auth": "1", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function initiatingSession() {
    const created = await sessions.createOwnerSession({
      credentialVersion: ownerFixture.credentialVersion, authenticationMethod: "ACCESS_CODE",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const cookie = `cr8or-dev-session=${created.token}`;
    const session = await auth.resolveAuthSession(request(cookie), false);
    expect(session).not.toBeNull();
    return { ...created, cookie, authSession: session! };
  }

  async function capability(permissions?: ExecutionAuthorizationContext["permissions"], signal?: AbortSignal) {
    const initiating = await initiatingSession();
    const authorization = await execution.createExecutionAuthorization(initiating.authSession, PROJECT_ID, { permissions, signal });
    expect(authorization).toBeDefined();
    return { ...initiating, authorization: authorization! };
  }

  function toolContext(authorization?: ExecutionAuthorizationContext, actorId = "frontend"): ToolContext {
    return { authorization, projectId: PROJECT_ID, workspaceRoot: path.join(root, "repo"),
      requestId: "synthetic-cloud-write", actorId, actorRole: "agent" };
  }

  async function source() { return fs.readFile(path.join(root, "repo", "source.txt"), "utf8"); }
  function commits() { return adapter.calls.inputs.filter((input) => / COMMIT\n$/.test(input.data)); }
  async function unchanged() {
    expect(await source()).toBe(ORIGINAL);
    expect(await fs.readdir(path.join(root, "repo"))).toEqual(["source.txt"]);
  }

  async function applyMigration(directory: string) {
    const sql = await fs.readFile(path.join(process.cwd(), "prisma/migrations", directory, "migration.sql"), "utf8");
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim())
      .filter((value) => value && !/^(BEGIN|COMMIT)$/i.test(value));
    await database.$transaction(async (transaction) => {
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    });
  }

  beforeAll(async () => {
    setEnvironment("NODE_ENV", "test");
    for (const name of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID", "CR8OR_WORKSPACE_MODE"]) setEnvironment(name, undefined);
    setEnvironment("CR8OR_PRIVATE_AUTH_ENABLED", "true");
    setEnvironment("CR8OR_PRIVATE_AUTH_ORIGIN", ORIGIN);
    setEnvironment("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", randomBytes(32).toString("base64url"));
    setEnvironment("CR8OR_FEATURE_AUTH_GUARD", "false");
    setEnvironment("CR8OR_FEATURE_AUDIT_LOG", "false");
    setEnvironment("DAYTONA_API_KEY", "synthetic-test-adapter-only");
    setEnvironment("DAYTONA_API_URL", "https://no-provider-requests.invalid/api");
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
    for (const migration of ["0_init", "20250101000000_add_workspace_table", "20261015000000_authentication_foundation"]) await applyMigration(migration);
    auth = await import("@/lib/security/auth");
    sessions = await import("@/lib/security/session-store");
    owners = await import("@/lib/security/owner-management");
    execution = await import("@/lib/security/execution-context");
    runtimes = await import("@/lib/workspace/runtime-factory");
    cloudFiles = await import("@/lib/workspace/private-cloud-write-session");
    providerModule = await import("@/lib/workspace/providers/daytona");
    tools = await import("@/lib/agents/tool-executor");
    policy = await import("@/lib/security/policy");
    filesRoute = await import("@/app/api/files/route");
    await owners.provisionOwner("1234");
    ownerFixture = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cr8or-cloud-write-db-"));
  }, 30_000);

  beforeEach(async () => {
    await database.authSession.deleteMany();
    await database.ownerCredential.deleteMany();
    await database.ownerCredential.create({ data: ownerFixture });
    await database.project.deleteMany();
    await database.project.create({ data: { id: PROJECT_ID, name: "Registered synthetic cloud workspace", description: "",
      framework: "Next.js", language: "TypeScript", workspaces: { create: {
        runtimeType: "cloud", state: "running", provider: "daytona", providerWorkspaceId: SANDBOX_ID,
        repositoryUrl: "https://github.com/example/synthetic-fixture", branch: "main",
      } } } });
    policy.setPolicyProfile("balanced");
    await fs.rm(path.join(root, "repo"), { recursive: true, force: true });
    await fs.mkdir(path.join(root, "repo"));
    await fs.writeFile(path.join(root, "repo", "source.txt"), ORIGINAL);
    adapter = createControlledDaytonaSessionAdapter(root);
    sandboxLookup = vi.fn<(id: string) => Promise<Sandbox | null>>().mockResolvedValue({ id: SANDBOX_ID, state: "started" } as unknown as Sandbox);
    sessionProcessLookup = vi.fn<(id: string) => Promise<Process>>().mockImplementation(async (id: string) => {
      if (id !== SANDBOX_ID) throw new Error("Unregistered test sandbox.");
      return adapter as unknown as Process;
    });
    vi.spyOn(providerModule.DaytonaProvider.prototype, "getSandbox").mockImplementation(sandboxLookup);
    vi.spyOn(providerModule.DaytonaProvider.prototype, "getPrivateFileSessionProcess").mockImplementation(sessionProcessLookup);
    vi.spyOn(providerModule.DaytonaProvider.prototype, "getSandboxFileSystem").mockImplementation(() => {
      throw new Error("Pathname-based transfer is forbidden in this test.");
    });
    vi.spyOn(providerModule.DaytonaProvider.prototype, "createSandbox").mockRejectedValue(new Error("Workspace creation is forbidden in this test."));
    vi.spyOn(providerModule.DaytonaProvider.prototype, "ensureSandbox").mockRejectedValue(new Error("Workspace creation is forbidden in this test."));
  });

  afterEach(async () => {
    await adapter?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    try {
      await database?.$disconnect();
      if (admin) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin?.$disconnect();
      if (root) await fs.rm(root, { recursive: true, force: true });
      if (previousGlobal === undefined) delete globalThis.prismaGlobal;
      else globalThis.prismaGlobal = previousGlobal;
      if (previousPolicy === undefined) delete globalThis.__cr8orPolicyStore;
      else globalThis.__cr8orPolicyStore = previousPolicy;
      for (const [name, value] of previousEnvironment) setEnvironment(name, value);
    }
  });

  it.each(["", "const greeting = 'café 🚀';\r\n\t// 精確\u0000\n"])("writes exact UTF-8 through the registered runtime: %j", async (content) => {
    const { authorization, token, session } = await capability();
    const runtime = await runtimes.getWorkspaceRuntime(PROJECT_ID, authorization);
    expect(await runtime.writeFile("source.txt", content)).toEqual({ bytes: Buffer.byteLength(content, "utf8") });
    expect(await source()).toBe(content);
    expect(sandboxLookup).toHaveBeenCalledWith(SANDBOX_ID);
    expect(sessionProcessLookup).toHaveBeenCalledWith(SANDBOX_ID);
    expect(adapter.calls.commands).toHaveLength(1);
    expect(adapter.calls.commands[0].request).toMatchObject({ runAsync: true, suppressInputEcho: true });
    const commands = JSON.stringify(adapter.calls.commands);
    expect(commands).not.toContain(token);
    expect(commands).not.toContain(session.id);
    if (content) {
      expect(commands).not.toContain(content);
      expect(commands).not.toContain(Buffer.from(content).toString("base64"));
    }
    expect(commits()).toHaveLength(1);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
    expect(await fs.readdir(path.join(root, "repo"))).toEqual(["source.txt"]);
  });

  it("connects the actual authorized file POST to the bounded transport", async () => {
    const { cookie } = await initiatingSession();
    const response = await filesRoute.POST(request(cookie, { projectId: PROJECT_ID, path: "source.txt", content: "direct source café\n" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ path: "source.txt", saved: true });
    expect(await source()).toBe("direct source café\n");
    expect(commits()).toHaveLength(1);
  });

  it("connects an authorized agent write_file operation to the same transport", async () => {
    const { authorization } = await capability();
    expect(await tools.executeTool("write_file", { path: "source.txt", content: "agent source 🚀\n" }, toolContext(authorization)))
      .toMatchObject({ ok: true, workspaceChanged: true, data: { bytes: Buffer.byteLength("agent source 🚀\n") } });
    expect(await source()).toBe("agent source 🚀\n");
    expect(commits()).toHaveLength(1);
  });

  it.each(["missing", "forged"] as const)("rejects %s cookies in the real POST before provider access", async (kind) => {
    const cookie = kind === "forged" ? `cr8or-dev-session=${randomBytes(32).toString("base64url")}` : undefined;
    const response = await filesRoute.POST(request(cookie, { projectId: PROJECT_ID, path: "source.txt", content: "rejected" }));
    expect(response.status).toBe(401);
    expect(sandboxLookup).not.toHaveBeenCalled();
    expect(adapter.calls.created).toEqual([]);
    await unchanged();
  });

  it("rejects cross-origin direct writes before provider access", async () => {
    const { cookie } = await initiatingSession();
    const response = await filesRoute.POST(request(cookie, { projectId: PROJECT_ID, path: "source.txt", content: "rejected" }, "https://untrusted.invalid"));
    expect(response.status).toBe(400);
    expect(sandboxLookup).not.toHaveBeenCalled();
    await unchanged();
  });

  it("rejects unknown project IDs before provider access", async () => {
    const { cookie } = await initiatingSession();
    const response = await filesRoute.POST(request(cookie, { projectId: "unregistered-project", path: "source.txt", content: "rejected" }));
    expect(response.status).toBe(404);
    expect(sandboxLookup).not.toHaveBeenCalled();
    await unchanged();
  });

  it.each(["missing", "copied", "forged-session"] as const)("rejects a %s execution context before session initialization", async (kind) => {
    const { authorization, session } = await capability();
    const context = kind === "missing" ? undefined : kind === "copied" ? { ...authorization }
      : { ownerId: "owner", projectId: PROJECT_ID, sessionId: session.id, permissions: ["read", "write"], workspace: authorization.workspace };
    await expect(cloudFiles.privateCloudWriteSession(adapter, PROJECT_ID, SANDBOX_ID, "source.txt", "rejected", context as ExecutionAuthorizationContext))
      .rejects.toMatchObject({ status: 401 });
    expect(adapter.calls.created).toEqual([]);
    await unchanged();
  });

  it("rejects project and provider substitutions before session initialization", async () => {
    for (const [projectId, sandboxId] of [["unregistered-project", SANDBOX_ID], [PROJECT_ID, "unregistered-sandbox"]]) {
      const { authorization } = await capability();
      await expect(cloudFiles.privateCloudWriteSession(adapter, projectId, sandboxId, "source.txt", "rejected", authorization))
        .rejects.toMatchObject({ status: 403 });
    }
    expect(adapter.calls.created).toEqual([]);
    await unchanged();
  });

  it("rejects read-only execution capabilities before creating a transfer", async () => {
    const { authorization } = await capability(["read"]);
    const runtime = await runtimes.getWorkspaceRuntime(PROJECT_ID, authorization);
    await expect(runtime.writeFile("source.txt", "rejected")).rejects.toMatchObject({ status: 403 });
    expect(sessionProcessLookup).not.toHaveBeenCalled();
    expect(adapter.calls.created).toEqual([]);
    await unchanged();
  });

  it("preserves an agent's tool tier even when its actorRole claims owner", async () => {
    const { authorization } = await capability();
    await expect(tools.executeTool("write_file", { path: "source.txt", content: "rejected" }, {
      ...toolContext(authorization, "security"), actorRole: "owner",
    })).rejects.toMatchObject({ status: 403 });
    expect(sandboxLookup).not.toHaveBeenCalled();
    await unchanged();
  });

  it("preserves approval requirements for agent writes", async () => {
    const { authorization } = await capability();
    policy.setPolicyProfile("strict");
    expect(await tools.executeTool("write_file", { path: "source.txt", content: "rejected" }, toolContext(authorization)))
      .toMatchObject({ ok: false, requiresApproval: true });
    expect(sandboxLookup).not.toHaveBeenCalled();
    await unchanged();
  });

  it("preserves approval requirements for direct writes", async () => {
    const { cookie } = await initiatingSession();
    policy.setPolicyProfile("strict");
    const response = await filesRoute.POST(request(cookie, { projectId: PROJECT_ID, path: "source.txt", content: "rejected" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, requiresApproval: true });
    expect(adapter.calls.created).toEqual([]);
    await unchanged();
  });

  it.each(["revoked", "expired", "rotated", "obsolete", "remapped", "disconnected"] as const)("withholds COMMIT after authorization becomes %s during transfer", async (state) => {
    const controller = new AbortController();
    const { authorization, session } = await capability(undefined, controller.signal);
    let changed = false;
    adapter = createControlledDaytonaSessionAdapter(root, { onLogs: async ({ stdout }) => {
      if (changed || !stdout.includes(" STAGED ")) return;
      changed = true;
      if (state === "revoked") await sessions.revokeSession(session.id);
      if (state === "expired") await database.authSession.update({ where: { id: session.id }, data: { authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) } });
      if (state === "rotated") await owners.rotateOwnerAccessCode("synthetic rotated code");
      if (state === "obsolete") await database.ownerCredential.update({ where: { id: "owner" }, data: { credentialVersion: { increment: 1 } } });
      if (state === "remapped") await database.workspace.update({ where: { projectId: PROJECT_ID }, data: { providerWorkspaceId: "replacement-sandbox" } });
      if (state === "disconnected") controller.abort();
    } });
    const runtime = await runtimes.getWorkspaceRuntime(PROJECT_ID, authorization);
    await expect(runtime.writeFile("source.txt", "must never replace the destination")).rejects.toMatchObject({ status: state === "remapped" ? 409 : 401 });
    expect(changed).toBe(true);
    expect(commits()).toEqual([]);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
    expect(authorization.signal.aborted).toBe(true);
    await unchanged();
    const created = adapter.calls.created.length;
    await expect(runtime.writeFile("source.txt", "subsequent rejected write")).rejects.toMatchObject({ status: 401 });
    expect(adapter.calls.created).toHaveLength(created);
    await unchanged();
  });

  it("fails closed if PostgreSQL session validation becomes unavailable before COMMIT", async () => {
    const { authorization } = await capability();
    let unavailable = false;
    adapter = createControlledDaytonaSessionAdapter(root, { onLogs: async ({ stdout }) => {
      if (unavailable || !stdout.includes(" STAGED ")) return;
      await database.$executeRawUnsafe('ALTER TABLE "AuthSession" RENAME TO "AuthSessionUnavailable"');
      unavailable = true;
    } });
    const runtime = await runtimes.getWorkspaceRuntime(PROJECT_ID, authorization);
    try {
      await expect(runtime.writeFile("source.txt", "rejected after database failure")).rejects.toMatchObject({ status: 503 });
      expect(unavailable).toBe(true);
      expect(commits()).toEqual([]);
      expect(adapter.calls.deleted).toEqual(adapter.calls.created);
      await unchanged();
    } finally {
      if (unavailable) await database.$executeRawUnsafe('ALTER TABLE "AuthSessionUnavailable" RENAME TO "AuthSession"');
    }
  });

  it("propagates revoked transfer authorization through the real file POST without success", async () => {
    const { cookie, session } = await initiatingSession();
    let revoked = false;
    adapter = createControlledDaytonaSessionAdapter(root, { onLogs: async ({ stdout }) => {
      if (!revoked && stdout.includes(" STAGED ")) { revoked = true; await sessions.revokeSession(session.id); }
    } });
    const response = await filesRoute.POST(request(cookie, { projectId: PROJECT_ID, path: "source.txt", content: "rejected source" }));
    expect(response.status).toBe(401);
    expect(revoked).toBe(true);
    expect(commits()).toEqual([]);
    await unchanged();
  });

  it("propagates revoked transfer authorization through agent execution without success", async () => {
    const { authorization, session } = await capability();
    let revoked = false;
    adapter = createControlledDaytonaSessionAdapter(root, { onLogs: async ({ stdout }) => {
      if (!revoked && stdout.includes(" STAGED ")) { revoked = true; await sessions.revokeSession(session.id); }
    } });
    await expect(tools.executeTool("write_file", { path: "source.txt", content: "rejected source" }, toolContext(authorization)))
      .rejects.toMatchObject({ status: 401 });
    expect(revoked).toBe(true);
    expect(commits()).toEqual([]);
    await unchanged();
  });

  it("retains the deployed availability restriction independently of the isolated test substitution", async () => {
    const actual = await vi.importActual<typeof import("@/lib/workspace/private-cloud-write-availability")>("@/lib/workspace/private-cloud-write-availability");
    expect(() => actual.assertPrivateCloudWriteTransportAvailable()).toThrow();
    expect(adapter.calls.created).toEqual([]);
    await unchanged();
  });
});
