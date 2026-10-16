import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { PrismaClient, type OwnerCredential } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/security/auth";
import type { ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import type { ToolContext } from "@/lib/agents/tools";
import type { DaytonaProvider } from "@/lib/workspace/providers/daytona";

vi.mock("server-only", () => ({}));
const model = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({
  ...await importOriginal<typeof import("ai")>(),
  generateText: model.generate,
}));

function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['postgresql:', 'postgres:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== '55432' || url.pathname !== '/cr8or_auth_test') {
    throw new Error("Execution integration tests require the isolated local test database on port 55432.");
  }
  return url;
}

const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const suffix = randomBytes(8).toString("hex");
const schemaName = `execution_authorization_${suffix}`;
const PROJECT_ID = `execution-fixture-${suffix}`;
const CLOUD_PROJECT_ID = `cloud-execution-fixture-${suffix}`;
const ROOT = path.join(process.cwd(), "projects", PROJECT_ID);
const OUTSIDE = path.join(process.cwd(), "projects", `execution-outside-${suffix}`);
const ORIGIN = "http://localhost:3000";
const environmentKeys = [
  "DATABASE_URL", "DIRECT_URL", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID",
  "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY",
  "CR8OR_FEATURE_AUTH_GUARD", "CR8OR_FEATURE_AUDIT_LOG", "CR8OR_WORKSPACE_MODE", "CR8OR_POLICY_PROFILE",
] as const;
const previousEnvironment = new Map(environmentKeys.map((name) => [name, process.env[name]]));
const previousGlobal = globalThis.prismaGlobal;
const previousPolicy = globalThis.__cr8orPolicyStore;

function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// No DATABASE_URL fallback, dotenv loading, existing schema mutation, provider
// calls, or real credentials. Every database row and local file is disposable.
describe.skipIf(!testUrl)("trusted execution authorization on isolated PostgreSQL", () => {
  let admin: PrismaClient;
  let database: PrismaClient;
  let ownerFixture: OwnerCredential;
  let auth: typeof import("@/lib/security/auth");
  let sessions: typeof import("@/lib/security/session-store");
  let owners: typeof import("@/lib/security/owner-management");
  let execution: typeof import("@/lib/security/execution-context");
  let runtimes: typeof import("@/lib/workspace/runtime-factory");
  let cloudRuntime: typeof import("@/lib/workspace/runtime-cloud");
  let tools: typeof import("@/lib/agents/tool-executor");
  let policy: typeof import("@/lib/security/policy");
  let chat: typeof import("@/app/api/chat/main/route");
  let orchestrate: typeof import("@/app/api/orchestrate/route");
  let stream: typeof import("@/app/api/orchestrate/stream/route");
  let orchestrationService: typeof import("@/lib/agents/orchestrator");
  let llm: typeof import("@/lib/agents/llm");
  let memory: typeof import("@/lib/agents/memory");

  function request(endpoint: string, cookie?: string, body?: unknown) {
    return new NextRequest(`${ORIGIN}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(cookie ? { cookie } : {}), origin: ORIGIN,
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
    const session = await auth.resolveAuthSession(request("/api/projects", cookie), false);
    expect(session).not.toBeNull();
    return { ...created, cookie, authSession: session! };
  }

  async function capability(projectId = PROJECT_ID, permissions?: ExecutionAuthorizationContext["permissions"], signal?: AbortSignal) {
    const initiating = await initiatingSession();
    const authorization = await execution.createExecutionAuthorization(initiating.authSession, projectId, { permissions, signal });
    expect(authorization).toBeDefined();
    return { ...initiating, authorization: authorization! };
  }

  function toolContext(authorization?: ExecutionAuthorizationContext, actorId = "frontend", projectId = PROJECT_ID): ToolContext {
    return { authorization, projectId, workspaceRoot: ROOT,
      requestId: "synthetic-execution-request", actorId, actorRole: "agent" };
  }

  function privateCloudRuntime(authorization?: ExecutionAuthorizationContext, providerWorkspaceId = "historical-provider-id") {
    const content = "synthetic cloud source\nconst label = 'café 🚀';\n";
    const remoteProcess = { executeCommand: vi.fn().mockResolvedValue({ exitCode: 0,
      result: JSON.stringify({ ok: true, data: { content, bytes: Buffer.byteLength(content, "utf8") } }) }) };
    const files = { uploadFile: vi.fn(), downloadFile: vi.fn(), createFolder: vi.fn(), listFiles: vi.fn() };
    const provider = {
      getSandbox: vi.fn().mockResolvedValue({ id: "historical-provider-id", state: "started" }),
      getSandboxProcess: vi.fn().mockReturnValue(remoteProcess),
      getSandboxFileSystem: vi.fn().mockReturnValue(files),
      createSandbox: vi.fn(), ensureSandbox: vi.fn(), findSandboxByName: vi.fn(),
    };
    const runtime = new cloudRuntime.CloudWorkspaceRuntime({
      id: authorization?.workspace.id ?? "untrusted-runtime", projectId: CLOUD_PROJECT_ID,
      provider: provider as unknown as DaytonaProvider, providerWorkspaceId,
      createdAt: new Date(), authorization,
    });
    return { runtime, remoteProcess, files, provider, content };
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
    cloudRuntime = await import("@/lib/workspace/runtime-cloud");
    tools = await import("@/lib/agents/tool-executor");
    policy = await import("@/lib/security/policy");
    chat = await import("@/app/api/chat/main/route");
    orchestrate = await import("@/app/api/orchestrate/route");
    stream = await import("@/app/api/orchestrate/stream/route");
    orchestrationService = await import("@/lib/agents/orchestrator");
    llm = await import("@/lib/agents/llm");
    memory = await import("@/lib/agents/memory");
    await owners.provisionOwner("1234");
    ownerFixture = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    await fs.mkdir(ROOT, { recursive: true });
    await fs.mkdir(OUTSIDE, { recursive: true });
    await fs.writeFile(path.join(OUTSIDE, "private.txt"), "outside project fixture");
  }, 30_000);

  beforeEach(async () => {
    model.generate.mockReset();
    model.generate.mockRejectedValue(new Error("External model requests are unavailable in these tests."));
    await database.authSession.deleteMany();
    await database.ownerCredential.deleteMany();
    await database.ownerCredential.create({ data: ownerFixture });
    await database.project.deleteMany();
    await database.project.create({ data: { id: PROJECT_ID, name: "Local execution fixture", description: "",
      framework: "Next.js", language: "TypeScript", workspaces: { create: { runtimeType: "local", state: "ready" } } } });
    await database.project.create({ data: { id: CLOUD_PROJECT_ID, name: "Existing cloud fixture", description: "",
      framework: "Next.js", language: "TypeScript", workspaces: { create: {
        runtimeType: "cloud", state: "running", provider: "daytona", providerWorkspaceId: "historical-provider-id",
        repositoryUrl: "https://github.com/example/synthetic-fixture", branch: "main",
      } } } });
    policy.setPolicyProfile("balanced");
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT);
    await fs.writeFile(path.join(ROOT, "source.txt"), "original fixture");
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  afterAll(async () => {
    try {
      await database?.$disconnect();
      if (admin) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin?.$disconnect();
      await fs.rm(ROOT, { recursive: true, force: true });
      await fs.rm(OUTSIDE, { recursive: true, force: true });
      if (previousGlobal === undefined) delete globalThis.prismaGlobal;
      else globalThis.prismaGlobal = previousGlobal;
      if (previousPolicy === undefined) delete globalThis.__cr8orPolicyStore;
      else globalThis.__cr8orPolicyStore = previousPolicy;
      for (const [name, value] of previousEnvironment) setEnvironment(name, value);
    }
  });

  it("binds the verified singleton and canonical project without serializing tokens or session references", async () => {
    const { authorization, token, session } = await capability();
    expect(authorization).toMatchObject({ ownerId: "owner", projectId: PROJECT_ID, workspace: { runtimeType: "local" } });
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(authorization.workspace)).toBe(true);
    expect(Object.isFrozen(authorization.permissions)).toBe(true);
    expect(JSON.stringify(authorization)).not.toContain(token);
    expect(JSON.stringify(authorization)).not.toContain(session.id);
    await expect(execution.revalidateExecutionAuthorization(authorization, PROJECT_ID, "read")).resolves.toBeUndefined();
  });

  it.each(["disabled", "dev-token", "supabase", "private-session"] as const)("rejects fabricated %s owner contexts before registry reads", async (provider) => {
    const registry = vi.spyOn(database.project, "findUnique");
    const forged: AuthSession = { provider, userId: "owner", role: "owner", authenticated: true };
    await expect(execution.createExecutionAuthorization(forged, PROJECT_ID)).rejects.toMatchObject({ status: 401 });
    expect(registry).not.toHaveBeenCalled();
  });

  it("rejects copied authentication contexts and guessed internal session IDs", async () => {
    const { authSession, session } = await initiatingSession();
    await expect(execution.createExecutionAuthorization({ ...authSession }, PROJECT_ID)).rejects.toMatchObject({ status: 401 });
    expect(await auth.resolveAuthSession(request("/api/projects", `cr8or-dev-session=${session.id}`), false)).toBeNull();
  });

  it("rejects missing and copied execution capabilities, including copied private symbols", async () => {
    const { authorization, session } = await capability();
    const symbolCopy = Object.create(null, Object.getOwnPropertyDescriptors(authorization)) as ExecutionAuthorizationContext;
    const claimedReference = { ...authorization, ownerId: "owner", sessionId: session.id } as unknown as ExecutionAuthorizationContext;
    for (const untrusted of [undefined, { ...authorization }, JSON.parse(JSON.stringify(authorization)), symbolCopy, claimedReference]) {
      await expect(execution.revalidateExecutionAuthorization(untrusted, PROJECT_ID, "read")).rejects.toMatchObject({ status: 401 });
    }
  });

  it("rejects unregistered projects without creating a workspace", async () => {
    const { authSession } = await initiatingSession();
    const create = vi.spyOn(database.workspace, "create");
    await expect(execution.createExecutionAuthorization(authSession, "unknown-project")).rejects.toMatchObject({ status: 404 });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects project substitution before reading another runtime", async () => {
    const { authorization } = await capability();
    await expect(runtimes.getWorkspaceRuntime(CLOUD_PROJECT_ID, authorization)).rejects.toMatchObject({ status: 403 });
    expect(authorization.signal.aborted).toBe(true);
  });

  it("rejects distinct registered local IDs that resolve to the same filesystem root", async () => {
    const { authorization, authSession } = await capability();
    await database.project.create({ data: {
      id: `projects/${PROJECT_ID}`, name: "Conflicting legacy alias", description: "",
      framework: "Next.js", language: "TypeScript",
      workspaces: { create: { runtimeType: "local", state: "ready" } },
    } });
    const open = vi.spyOn(fs, "open");
    await expect(execution.createExecutionAuthorization(authSession, PROJECT_ID)).rejects.toMatchObject({ status: 409 });
    await expect(tools.executeTool("read_file", { path: "source.txt" }, toolContext(authorization))).rejects.toMatchObject({ status: 409 });
    expect(open).not.toHaveBeenCalled();
    expect(await database.project.count({ where: { id: { in: [PROJECT_ID, `projects/${PROJECT_ID}`] } } })).toBe(2);
  });

  it.each(["revoked", "expired", "obsolete", "rotated"] as const)("revalidates %s sessions from PostgreSQL and cancels subsequent operations", async (state) => {
    const { authorization, session } = await capability();
    if (state === "revoked") await sessions.revokeSession(session.id);
    if (state === "expired") await database.authSession.update({ where: { id: session.id }, data: {
      authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
    } });
    if (state === "obsolete") await database.ownerCredential.update({ where: { id: "owner" }, data: { credentialVersion: { increment: 1 } } });
    if (state === "rotated") await owners.rotateOwnerAccessCode("7");
    await expect(execution.revalidateExecutionAuthorization(authorization, PROJECT_ID, "read")).rejects.toMatchObject({ status: 401 });
    expect(authorization.signal.aborted).toBe(true);
    await expect(tools.executeTool("write_file", { path: "source.txt", content: "unauthorized" }, toolContext(authorization))).rejects.toMatchObject({ status: 401 });
    expect(await fs.readFile(path.join(ROOT, "source.txt"), "utf8")).toBe("original fixture");
  });

  it("rechecks a session invalidated after initial request authentication", async () => {
    const { authSession, session } = await initiatingSession();
    await sessions.revokeSession(session.id);
    await expect(execution.createExecutionAuthorization(authSession, PROJECT_ID)).rejects.toMatchObject({ status: 401 });
  });

  it("does not downgrade an already private execution when activation configuration is removed", async () => {
    const { authorization } = await capability();
    const saved = new Map(["CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY"]
      .map((name) => [name, process.env[name]]));
    try {
      for (const name of saved.keys()) delete process.env[name];
      await expect(execution.revalidateExecutionAuthorization(authorization, PROJECT_ID, "read")).rejects.toMatchObject({ status: 503 });
      expect(authorization.signal.aborted).toBe(true);
    } finally {
      for (const [name, value] of saved) setEnvironment(name, value);
    }
  });

  it.each(["remapped", "deleted", "duplicate"] as const)("rejects a %s cloud association before provider resolution", async (change) => {
    const { authorization } = await capability(CLOUD_PROJECT_ID);
    if (change === "remapped") await database.workspace.update({ where: { projectId: CLOUD_PROJECT_ID }, data: { providerWorkspaceId: "unrelated-runtime" } });
    if (change === "deleted") await database.workspace.delete({ where: { projectId: CLOUD_PROJECT_ID } });
    if (change === "duplicate") await database.workspace.update({ where: { projectId: PROJECT_ID }, data: {
      runtimeType: "cloud", provider: "daytona", providerWorkspaceId: "historical-provider-id",
    } });
    await expect(runtimes.getWorkspaceRuntime(CLOUD_PROJECT_ID, authorization)).rejects.toMatchObject({ status: 409 });
    expect(authorization.signal.aborted).toBe(true);
  });

  it("blocks private cloud writes for a valid owner before command or file-transfer dispatch", async () => {
    const { authorization } = await capability(CLOUD_PROJECT_ID);
    const { runtime, remoteProcess, files, provider } = privateCloudRuntime(authorization);
    await runtime.initialize();
    await expect(runtime.writeFile("source.ts", "private content must never enter command arguments"))
      .rejects.toMatchObject({ status: 503 });
    expect(remoteProcess.executeCommand).not.toHaveBeenCalled();
    expect(provider.getSandboxFileSystem).not.toHaveBeenCalled();
    expect(files.uploadFile).not.toHaveBeenCalled();
    expect(files.createFolder).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(provider.ensureSandbox).not.toHaveBeenCalled();
  });

  it("preserves bounded private cloud reads and listings through the registered provider binding", async () => {
    const { authorization } = await capability(CLOUD_PROJECT_ID);
    const { runtime, remoteProcess, files, provider, content } = privateCloudRuntime(authorization);
    await runtime.initialize();
    await expect(runtime.readFile("source.ts")).resolves.toEqual({ content, bytes: Buffer.byteLength(content, "utf8") });
    const entries = [{ name: "source.ts", type: "file" }, { name: "src", type: "directory" }];
    remoteProcess.executeCommand.mockResolvedValueOnce({ exitCode: 0, result: JSON.stringify({ ok: true, data: entries }) });
    await expect(runtime.listFiles()).resolves.toEqual(entries);
    expect(provider.getSandbox).toHaveBeenCalledExactlyOnceWith("historical-provider-id");
    expect(remoteProcess.executeCommand).toHaveBeenCalledTimes(2);
    expect(files.downloadFile).not.toHaveBeenCalled();
    expect(files.listFiles).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(provider.ensureSandbox).not.toHaveBeenCalled();
    expect(provider.findSandboxByName).not.toHaveBeenCalled();
  });

  it.each(["missing", "fabricated"] as const)("rejects %s cloud execution capabilities before provider access", async (kind) => {
    const { authorization } = await capability(CLOUD_PROJECT_ID);
    const untrusted = kind === "missing" ? undefined : { ...authorization };
    const { runtime, provider, remoteProcess, files } = privateCloudRuntime(untrusted as ExecutionAuthorizationContext | undefined);
    await expect(runtime.initialize()).rejects.toMatchObject({ status: 401 });
    await expect(runtime.writeFile("source.ts", "unauthorized")).rejects.toMatchObject({ status: 401 });
    expect(provider.getSandbox).not.toHaveBeenCalled();
    expect(remoteProcess.executeCommand).not.toHaveBeenCalled();
    expect(files.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects cloud writes outside the initiating execution permissions before transport", async () => {
    const { authorization } = await capability(CLOUD_PROJECT_ID, ["read"]);
    const { runtime, remoteProcess, files } = privateCloudRuntime(authorization);
    await runtime.initialize();
    await expect(runtime.writeFile("source.ts", "unauthorized")).rejects.toMatchObject({ status: 403 });
    expect(remoteProcess.executeCommand).not.toHaveBeenCalled();
    expect(files.uploadFile).not.toHaveBeenCalled();
  });

  it.each(["revoked", "expired", "obsolete", "rotated"] as const)("rejects a cloud write after its session becomes %s without contacting the provider", async (state) => {
    const { authorization, session } = await capability(CLOUD_PROJECT_ID);
    const { runtime, remoteProcess, files, content } = privateCloudRuntime(authorization);
    await runtime.initialize();
    await expect(runtime.readFile("source.ts")).resolves.toMatchObject({ content });
    remoteProcess.executeCommand.mockClear();
    if (state === "revoked") await sessions.revokeSession(session.id);
    if (state === "expired") await database.authSession.update({ where: { id: session.id }, data: {
      authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
    } });
    if (state === "obsolete") await database.ownerCredential.update({ where: { id: "owner" }, data: { credentialVersion: { increment: 1 } } });
    if (state === "rotated") await owners.rotateOwnerAccessCode("7");
    await expect(runtime.writeFile("source.ts", "unauthorized")).rejects.toMatchObject({ status: 401 });
    expect(authorization.signal.aborted).toBe(true);
    expect(remoteProcess.executeCommand).not.toHaveBeenCalled();
    expect(files.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects cloud runtime identifier substitution before provider access", async () => {
    const { authorization } = await capability(CLOUD_PROJECT_ID);
    const { runtime, provider, remoteProcess, files } = privateCloudRuntime(authorization, "unrelated-provider-id");
    await expect(runtime.initialize()).rejects.toMatchObject({ status: 403 });
    await expect(runtime.writeFile("source.ts", "unauthorized")).rejects.toMatchObject({ status: 403 });
    expect(provider.getSandbox).not.toHaveBeenCalled();
    expect(remoteProcess.executeCommand).not.toHaveBeenCalled();
    expect(files.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects cloud writes when the persisted workspace binding changes after initialization", async () => {
    const { authorization } = await capability(CLOUD_PROJECT_ID);
    const { runtime, remoteProcess, files } = privateCloudRuntime(authorization);
    await runtime.initialize();
    await database.workspace.update({ where: { projectId: CLOUD_PROJECT_ID }, data: { providerWorkspaceId: "unrelated-provider-id" } });
    await expect(runtime.writeFile("source.ts", "unauthorized")).rejects.toMatchObject({ status: 409 });
    expect(remoteProcess.executeCommand).not.toHaveBeenCalled();
    expect(files.uploadFile).not.toHaveBeenCalled();
  });

  it("withholds cloud read results and prevents subsequent writes after revocation during transport", async () => {
    const { authorization, session } = await capability(CLOUD_PROJECT_ID);
    const { runtime, remoteProcess, files, content } = privateCloudRuntime(authorization);
    await runtime.initialize();
    remoteProcess.executeCommand.mockImplementationOnce(async () => {
      await sessions.revokeSession(session.id);
      return { exitCode: 0, result: JSON.stringify({ ok: true, data: { content, bytes: Buffer.byteLength(content, "utf8") } }) };
    });
    await expect(runtime.readFile("source.ts")).rejects.toMatchObject({ status: 401 });
    await expect(runtime.writeFile("source.ts", "unauthorized")).rejects.toMatchObject({ status: 401 });
    expect(authorization.signal.aborted).toBe(true);
    expect(remoteProcess.executeCommand).toHaveBeenCalledOnce();
    expect(files.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects cloud path traversal without dispatching a filesystem command", async () => {
    const { authorization } = await capability(CLOUD_PROJECT_ID);
    const { runtime, remoteProcess, files } = privateCloudRuntime(authorization);
    await runtime.initialize();
    for (const target of ["../outside.txt", "/etc/passwd", "nested/../../outside.txt"]) {
      await expect(runtime.readFile(target)).rejects.toThrow();
      await expect(runtime.writeFile(target, "unauthorized")).rejects.toThrow();
    }
    expect(remoteProcess.executeCommand).not.toHaveBeenCalled();
    expect(files.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects a project removed during execution", async () => {
    const { authorization } = await capability();
    await database.project.delete({ where: { id: PROJECT_ID } });
    await expect(execution.revalidateExecutionAuthorization(authorization, PROJECT_ID, "read")).rejects.toMatchObject({ status: 404 });
  });

  it("allows actual agent reads and writes inside the registered project", async () => {
    const { authorization } = await capability();
    expect(await tools.executeTool("read_file", { path: "source.txt" }, toolContext(authorization))).toMatchObject({ ok: true, data: { content: "original fixture" } });
    expect(await tools.executeTool("write_file", { path: "written.txt", content: "authorized fixture" }, toolContext(authorization))).toMatchObject({ ok: true, workspaceChanged: true });
    expect(await fs.readFile(path.join(ROOT, "written.txt"), "utf8")).toBe("authorized fixture");
  });

  it("stops the next read and write when a session is revoked between tool calls", async () => {
    const { authorization, session } = await capability();
    expect((await tools.executeTool("read_file", { path: "source.txt" }, toolContext(authorization))).ok).toBe(true);
    await sessions.revokeSession(session.id);
    await expect(tools.executeTool("read_file", { path: "source.txt" }, toolContext(authorization))).rejects.toMatchObject({ status: 401 });
    await expect(tools.executeTool("write_file", { path: "source.txt", content: "unauthorized" }, toolContext(authorization))).rejects.toMatchObject({ status: 401 });
    expect(await fs.readFile(path.join(ROOT, "source.txt"), "utf8")).toBe("original fixture");
  });

  it("does not accept an agent's owner role as initiating authentication", async () => {
    const context = { ...toolContext(), actorRole: "owner" };
    await expect(tools.executeTool("read_file", { path: "source.txt" }, context)).rejects.toMatchObject({ status: 401 });
  });

  it("preserves actor permission tiers independently of an owner role claim", async () => {
    const { authorization } = await capability();
    await expect(tools.executeTool("write_file", { path: "source.txt", content: "unauthorized" }, {
      ...toolContext(authorization, "security"), actorRole: "owner",
    })).rejects.toMatchObject({ status: 403 });
    expect(await fs.readFile(path.join(ROOT, "source.txt"), "utf8")).toBe("original fixture");
  });

  it("enforces a read-only execution permission even for a writer agent", async () => {
    const { authorization } = await capability(PROJECT_ID, ["read"]);
    await expect(tools.executeTool("write_file", { path: "source.txt", content: "unauthorized" }, toolContext(authorization))).rejects.toMatchObject({ status: 403 });
    expect(await fs.readFile(path.join(ROOT, "source.txt"), "utf8")).toBe("original fixture");
  });

  it("preserves approval requirements after session and project authorization", async () => {
    const { authorization } = await capability();
    policy.setPolicyProfile("strict");
    expect(await tools.executeTool("write_file", { path: "source.txt", content: "not approved" }, toolContext(authorization)))
      .toMatchObject({ ok: false, requiresApproval: true });
    expect(await fs.readFile(path.join(ROOT, "source.txt"), "utf8")).toBe("original fixture");
  });

  it("rejects model-supplied project overrides in tool parameters", async () => {
    const { authorization } = await capability();
    expect(await tools.executeTool("read_file", { path: "source.txt", projectId: CLOUD_PROJECT_ID }, toolContext(authorization)))
      .toMatchObject({ ok: false });
  });

  it.each(["../outside.txt", "/etc/passwd", "nested/../../outside.txt", ".env", "nested/.env.local"])("rejects unauthorized local path %s", async (input) => {
    const { authorization } = await capability();
    const runtime = await runtimes.getWorkspaceRuntime(PROJECT_ID, authorization);
    await expect(runtime.readFile(input)).rejects.toThrow();
    await expect(runtime.writeFile(input, "unauthorized")).rejects.toThrow();
  });

  it("rejects symlink and hardlink access outside the canonical project", async () => {
    const { authorization } = await capability();
    const runtime = await runtimes.getWorkspaceRuntime(PROJECT_ID, authorization);
    await fs.symlink(OUTSIDE, path.join(ROOT, "escape"), "dir");
    await fs.link(path.join(OUTSIDE, "private.txt"), path.join(ROOT, "linked.txt"));
    for (const input of ["escape/private.txt", "linked.txt"]) {
      await expect(runtime.readFile(input)).rejects.toThrow();
      await expect(runtime.writeFile(input, "unauthorized")).rejects.toThrow();
    }
    expect(await fs.readFile(path.join(OUTSIDE, "private.txt"), "utf8")).toBe("outside project fixture");
  });

  it("cancels pending work on disconnect without allowing subsequent filesystem writes", async () => {
    const controller = new AbortController();
    const { authorization } = await capability(PROJECT_ID, undefined, controller.signal);
    controller.abort();
    await expect(tools.executeTool("write_file", { path: "source.txt", content: "unauthorized" }, toolContext(authorization))).rejects.toMatchObject({ status: 401 });
    expect(authorization.signal.aborted).toBe(true);
    expect(await fs.readFile(path.join(ROOT, "source.txt"), "utf8")).toBe("original fixture");
  });

  it("keeps local host commands unavailable even to an authenticated writer", async () => {
    const { authorization } = await capability();
    await expect(tools.executeTool("run_command", { command: "npm run typecheck" }, toolContext(authorization)))
      .rejects.toMatchObject({ status: 503 });
  });

  it("fails closed when the database becomes unavailable during execution", async () => {
    const { authorization } = await capability();
    await database.$executeRawUnsafe('ALTER TABLE "AuthSession" RENAME TO "AuthSessionUnavailable"');
    try {
      await expect(tools.executeTool("write_file", { path: "source.txt", content: "unauthorized" }, toolContext(authorization))).rejects.toMatchObject({ status: 503 });
      expect(authorization.signal.aborted).toBe(true);
      expect(await fs.readFile(path.join(ROOT, "source.txt"), "utf8")).toBe("original fixture");
    } finally {
      await database.$executeRawUnsafe('ALTER TABLE "AuthSessionUnavailable" RENAME TO "AuthSession"');
    }
  });

  it("rejects unknown projects through actual chat and orchestration handlers before network or memory work", async () => {
    const { cookie } = await initiatingSession();
    const network = vi.fn(() => { throw new Error("External requests must not run."); });
    vi.stubGlobal("fetch", network);
    const taskWrite = vi.spyOn(database.task, "create");
    const memoryWrite = vi.spyOn(database.globalMemory, "create");
    for (const [endpoint, handler] of [["/api/chat/main", chat.POST], ["/api/orchestrate", orchestrate.POST], ["/api/orchestrate/stream", stream.POST]] as const) {
      const response = await handler(request(endpoint, cookie, { projectId: "unknown-project", prompt: "Read the project", message: "Read source.txt" }));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(network).not.toHaveBeenCalled();
    expect(taskWrite).not.toHaveBeenCalled();
    expect(memoryWrite).not.toHaveBeenCalled();
  });

  it("stops actual orchestration when the database session expires between progress events", async () => {
    const { authorization, session } = await capability();
    const provider = vi.spyOn(llm, "getModelForTools");
    const notes = vi.spyOn(memory, "writeLocalNote");
    const progress: string[] = [];
    await expect(orchestrationService.orchestrate({ projectId: PROJECT_ID, prompt: "Implement a backend API" }, async (event) => {
      progress.push(event.type);
      await database.authSession.update({ where: { id: session.id }, data: {
        authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
      } });
    }, authorization)).rejects.toMatchObject({ status: 401 });
    expect(progress).toEqual(["agent_update"]);
    expect(provider).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
    expect(notes).not.toHaveBeenCalled();
    expect(authorization.signal.aborted).toBe(true);
  });

  it.each(["revoked", "expired"] as const)("stops the real streaming pipeline after the initiating database session is %s", async (state) => {
    const { cookie, session } = await initiatingSession();
    vi.spyOn(llm, "getModelForTools").mockReturnValue({} as ReturnType<typeof llm.getModelForTools>);
    const notes = vi.spyOn(memory, "writeLocalNote");
    model.generate.mockImplementation(async () => {
      if (state === "revoked") await sessions.revokeSession(session.id);
      else await database.authSession.update({ where: { id: session.id }, data: {
        authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
      } });
      return { text: "private model output must be withheld", toolCalls: [
        { toolName: "write_file", input: { path: "source.txt", content: "unauthorized write" } },
      ] };
    });
    const response = await stream.POST(request("/api/orchestrate/stream", cookie, { projectId: PROJECT_ID, prompt: "Implement a backend API" }));
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain('"type":"agent_update"');
    expect(events).toContain('"type":"error"');
    expect(events).not.toContain('"type":"done"');
    expect(events).not.toContain('"type":"tool_progress"');
    expect(events).not.toContain("private model output");
    expect(model.generate).toHaveBeenCalledOnce();
    expect(model.generate.mock.calls[0][0].abortSignal.aborted).toBe(true);
    expect(notes).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(ROOT, "source.txt"), "utf8")).toBe("original fixture");
  });

  it("uses the shared authorized runtime for actual direct-chat reads", async () => {
    const { cookie } = await initiatingSession();
    const network = vi.fn(() => { throw new Error("Direct reads must not invoke a provider."); });
    vi.stubGlobal("fetch", network);
    const response = await chat.POST(request("/api/chat/main", cookie, { projectId: PROJECT_ID, message: "Read source.txt" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("original fixture");
    expect(network).not.toHaveBeenCalled();
  });

  it("withholds direct-chat file content if the database session is revoked during a read", async () => {
    const { cookie, session } = await initiatingSession();
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await originalOpen(...args);
      await sessions.revokeSession(session.id);
      return file;
    });
    const response = await chat.POST(request("/api/chat/main", cookie, { projectId: PROJECT_ID, message: "Read source.txt" }));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("original fixture");
  });
});
