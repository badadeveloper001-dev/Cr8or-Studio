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
import type { ValidatedCommandRequest } from "@/lib/workspace/runtime";
import { createControlledCommandSessionAdapter, type ControlledCommandSessionAdapter } from "../helpers/command-session-adapter";

vi.mock("server-only", () => ({}));
// All provider access below uses disposable local fixtures. Constructing a real
// SDK client is forbidden; no live Daytona compatibility is claimed here.
vi.mock("@daytona/sdk", () => ({ Daytona: class {} }));
// Only the release restriction is substituted. Sessions, project authorization,
// command policy, PostgreSQL coordination, and runtime binding remain real.
vi.mock("@/lib/workspace/private-cloud-command-availability", () => ({
  assertPrivateCloudCommandAvailable: vi.fn(),
}));

function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "55432" || url.pathname !== "/cr8or_auth_test") {
    throw new Error("Command authorization tests require the isolated local test database on port 55432.");
  }
  return url;
}

const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const suffix = randomBytes(8).toString("hex");
const schemaName = `command_authorization_${suffix}`;
const PROJECT_ID = `command-fixture-${suffix}`;
const SANDBOX_ID = `registered-command-sandbox-${suffix}`;
const ORIGIN = "http://localhost:3000";
const environmentKeys = [
  "DATABASE_URL", "DIRECT_URL", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID",
  "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY",
  "CR8OR_FEATURE_AUTH_GUARD", "CR8OR_FEATURE_AUDIT_LOG", "CR8OR_WORKSPACE_MODE", "CR8OR_POLICY_PROFILE",
  "DAYTONA_API_KEY", "DAYTONA_API_URL", "CR8OR_SYNTHETIC_COMMAND_SECRET",
] as const;
const previousEnvironment = new Map(environmentKeys.map((name) => [name, process.env[name]]));
const previousGlobal = globalThis.prismaGlobal;
const previousPolicy = globalThis.__cr8orPolicyStore;
const previousApprovals = globalThis.__cr8orApprovalStore;

function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe.skipIf(!testUrl)("command execution authorization on isolated PostgreSQL", () => {
  let admin: PrismaClient;
  let database: PrismaClient;
  let ownerFixture: OwnerCredential;
  let root: string;
  let adapter: ControlledCommandSessionAdapter;
  let sandboxLookup: Mock<(id: string) => Promise<Sandbox | null>>;
  let sessionProcessLookup: Mock<(id: string) => Promise<Process>>;
  let auth: typeof import("@/lib/security/auth");
  let sessions: typeof import("@/lib/security/session-store");
  let owners: typeof import("@/lib/security/owner-management");
  let execution: typeof import("@/lib/security/execution-context");
  let commands: typeof import("@/lib/security/command-authorization");
  let runtimes: typeof import("@/lib/workspace/runtime-factory");
  let transport: typeof import("@/lib/workspace/private-cloud-command-session");
  let providerModule: typeof import("@/lib/workspace/providers/daytona");
  let tools: typeof import("@/lib/agents/tool-executor");
  let policy: typeof import("@/lib/security/policy");
  let approvals: typeof import("@/lib/security/command-approvals");

  function request(cookie?: string) {
    return new NextRequest(`${ORIGIN}/api/auth/session`, { headers: cookie ? { cookie } : {} });
  }

  async function initiatingSession() {
    const created = await sessions.createOwnerSession({ credentialVersion: ownerFixture.credentialVersion,
      authenticationMethod: "ACCESS_CODE", expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    const authSession = await auth.resolveAuthSession(request(`cr8or-dev-session=${created.token}`), false);
    expect(authSession).not.toBeNull();
    return { ...created, authSession: authSession! };
  }

  async function capability(permissions?: ExecutionAuthorizationContext["permissions"], signal?: AbortSignal) {
    const initiating = await initiatingSession();
    const authorization = await execution.createExecutionAuthorization(initiating.authSession, PROJECT_ID, { permissions, signal });
    expect(authorization).toBeDefined();
    return { ...initiating, authorization: authorization! };
  }

  function toolContext(authorization?: ExecutionAuthorizationContext, actorId = "frontend"): ToolContext {
    return { authorization, projectId: PROJECT_ID, workspaceRoot: path.join(root, "repo"),
      requestId: "synthetic-command-operation", actorId, actorRole: "agent" };
  }

  async function commandRequest(authorization: ExecutionAuthorizationContext, command = "npm run typecheck") {
    const result = await commands.authorizeDevelopmentCommand(toolContext(authorization), command);
    if (!result.allowed) throw new Error("Synthetic command fixture unexpectedly denied.");
    return { command, commandKey: command, rules: [{ kind: "exact", value: command }], timeoutMs: 60_000,
      commandAuthorization: result.authorization } satisfies ValidatedCommandRequest;
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
    setEnvironment("DAYTONA_API_KEY", "synthetic-command-adapter-only");
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
    for (const migration of ["0_init", "20250101000000_add_workspace_table", "20261015000000_authentication_foundation", "20261016000000_command_operations", "20261016010000_command_approvals", "20261016020000_git_operations", "20261017000000_workspace_lifecycle"]) await applyMigration(migration);
    auth = await import("@/lib/security/auth");
    sessions = await import("@/lib/security/session-store");
    owners = await import("@/lib/security/owner-management");
    execution = await import("@/lib/security/execution-context");
    commands = await import("@/lib/security/command-authorization");
    runtimes = await import("@/lib/workspace/runtime-factory");
    transport = await import("@/lib/workspace/private-cloud-command-session");
    providerModule = await import("@/lib/workspace/providers/daytona");
    tools = await import("@/lib/agents/tool-executor");
    policy = await import("@/lib/security/policy");
    approvals = await import("@/lib/security/command-approvals");
    await owners.provisionOwner("1234");
    ownerFixture = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cr8or-command-db-"));
  }, 30_000);

  beforeEach(async () => {
    await database.commandApproval.deleteMany();
    await database.commandOperation.deleteMany();
    await database.authSession.deleteMany();
    await database.ownerCredential.deleteMany();
    await database.ownerCredential.create({ data: ownerFixture });
    await database.project.deleteMany();
    await database.project.create({ data: { id: PROJECT_ID, name: "Registered synthetic command workspace", description: "",
      framework: "Next.js", language: "TypeScript", workspaces: { create: {
        runtimeType: "cloud", state: "running", provider: "daytona", providerWorkspaceId: SANDBOX_ID,
        repositoryUrl: "https://github.com/example/synthetic-fixture", branch: "main",
      } } } });
    policy.setPolicyProfile("autonomous");
    globalThis.__cr8orApprovalStore = { records: [] };
    await fs.rm(path.join(root, "repo"), { recursive: true, force: true });
    await fs.mkdir(path.join(root, "repo"));
    await fs.writeFile(path.join(root, "repo", "package.json"), JSON.stringify({ name: "isolated-command-fixture", private: true,
      scripts: { typecheck: "node fixture.cjs", lint: "node fixture.cjs", test: "node fixture.cjs", "test:unit": "node fixture.cjs", "test:integration": "node fixture.cjs" } }));
    await fs.writeFile(path.join(root, "repo", "fixture.cjs"), "process.stdout.write('synthetic successful check café 🚀\\n');\n");
    adapter = createControlledCommandSessionAdapter(root);
    sandboxLookup = vi.fn<(id: string) => Promise<Sandbox | null>>().mockResolvedValue({ id: SANDBOX_ID, state: "started" } as unknown as Sandbox);
    sessionProcessLookup = vi.fn<(id: string) => Promise<Process>>().mockImplementation(async (id: string) => {
      if (id !== SANDBOX_ID) throw new Error("Unregistered test sandbox.");
      return adapter as unknown as Process;
    });
    vi.spyOn(providerModule.DaytonaProvider.prototype, "getSandbox").mockImplementation(sandboxLookup);
    vi.spyOn(providerModule.DaytonaProvider.prototype, "getPrivateCommandSessionProcess").mockImplementation(sessionProcessLookup);
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
      if (previousApprovals === undefined) delete globalThis.__cr8orApprovalStore;
      else globalThis.__cr8orApprovalStore = previousApprovals;
      for (const [name, value] of previousEnvironment) setEnvironment(name, value);
    }
  });

  it.each(["missing", "forged"] as const)("rejects %s authentication before provider work", async (kind) => {
    const cookie = kind === "forged" ? `cr8or-dev-session=${randomBytes(32).toString("base64url")}` : undefined;
    expect(await auth.resolveAuthSession(request(cookie), false)).toBeNull();
    await expect(tools.executeTool("run_command", { command: "npm test" }, toolContext())).rejects.toMatchObject({ status: 401 });
    expect(sandboxLookup).not.toHaveBeenCalled();
    expect(adapter.calls.created).toEqual([]);
  });

  it.each(["missing", "copied", "forged-session"] as const)("rejects %s execution capability before reserving or dispatching", async (kind) => {
    const { authorization, session } = await capability();
    const command = await commandRequest(authorization);
    const context = kind === "missing" ? undefined : kind === "copied" ? { ...authorization }
      : { ownerId: "owner", projectId: PROJECT_ID, sessionId: session.id, permissions: ["read", "command"], workspace: authorization.workspace };
    await expect(transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, command, context as ExecutionAuthorizationContext))
      .rejects.toMatchObject({ status: kind === "missing" ? 401 : 403 });
    expect(adapter.calls.created).toEqual([]);
    expect(await database.commandOperation.count()).toBe(0);
  });

  it("rejects unknown projects before obtaining a runtime", async () => {
    const { authSession } = await initiatingSession();
    await expect(execution.createExecutionAuthorization(authSession, "unknown-project")).rejects.toMatchObject({ status: 404 });
    expect(sandboxLookup).not.toHaveBeenCalled();
  });

  it.each(["project", "sandbox"] as const)("rejects substituted %s identity before creating a remote session", async (kind) => {
    const { authorization } = await capability();
    const command = await commandRequest(authorization);
    await expect(transport.privateCloudCommandSession(adapter, kind === "project" ? "other-project" : PROJECT_ID,
      kind === "sandbox" ? "other-sandbox" : SANDBOX_ID, command, authorization)).rejects.toMatchObject({ status: 403 });
    expect(adapter.calls.created).toEqual([]);
    expect(await database.commandOperation.count()).toBe(0);
  });

  it.each(["security", "qa", "main-chat", "invented-agent"])("does not grant command permission to %s claiming owner role", async (actorId) => {
    const { authorization } = await capability();
    await expect(tools.executeTool("run_command", { command: "npm test" }, { ...toolContext(authorization, actorId), actorRole: "owner" }))
      .rejects.toMatchObject({ status: 403 });
    expect(sandboxLookup).not.toHaveBeenCalled();
    expect(adapter.calls.created).toEqual([]);
  });

  it("rejects command permission missing from the genuine execution capability", async () => {
    const { authorization } = await capability(["read", "write"]);
    await expect(tools.executeTool("run_command", { command: "npm test" }, toolContext(authorization))).rejects.toMatchObject({ status: 403 });
    expect(adapter.calls.created).toEqual([]);
  });

  it.each(["balanced", "strict"] as const)("retains approval requirements under %s policy", async (profile) => {
    const { authorization } = await capability();
    policy.setPolicyProfile(profile);
    expect(await tools.executeTool("run_command", { command: "npm test" }, toolContext(authorization)))
      .toMatchObject({ ok: false, requiresApproval: true });
    expect(sandboxLookup).not.toHaveBeenCalled();
    expect(adapter.calls.created).toEqual([]);
  });

  it.each(["npm test; echo injected", "npm test $(whoami)", "npm test -- --watch", "node fixture.cjs", "npm run typecheck\n"])("rejects non-catalogue command %j", async (command) => {
    const { authorization } = await capability();
    const result = await tools.executeTool("run_command", { command }, toolContext(authorization));
    expect(result).toMatchObject({ ok: false });
    expect(adapter.calls.created).toEqual([]);
  });

  it("rejects caller command rules and execution overrides independently at runtime", async () => {
    for (const replacement of [
      { rules: [{ kind: "prefix", value: "npm" }] }, { command: "npm test; echo injected" },
      { cwd: "/" }, { envOverrides: { SYNTHETIC: "untrusted" } }, { commandAuthorization: {} },
    ]) {
      const { authorization } = await capability();
      const command = await commandRequest(authorization);
      const runtime = await runtimes.getWorkspaceRuntime(PROJECT_ID, authorization);
      await expect(runtime.runCommand({ ...command, ...replacement } as ValidatedCommandRequest)).rejects.toMatchObject({ status: 403 });
    }
    expect(adapter.calls.created).toEqual([]);
    expect(sessionProcessLookup).not.toHaveBeenCalled();
  });

  it.each(["revoked", "expired", "rotated"] as const)("rejects %s owner sessions before dispatch", async (state) => {
    const { authorization, session } = await capability();
    const command = await commandRequest(authorization);
    if (state === "revoked") await sessions.revokeSession(session.id);
    if (state === "expired") await database.authSession.update({ where: { id: session.id }, data: {
      authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
    } });
    if (state === "rotated") await owners.rotateOwnerAccessCode("synthetic replacement");
    await expect(transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, command, authorization)).rejects.toMatchObject({ status: 401 });
    expect(adapter.calls.created).toEqual([]);
    expect(await database.commandOperation.count()).toBe(0);
  });

  it.each(["npm run typecheck", "npm run lint", "npm test", "npm run test:unit", "npm run test:integration"])("runs exact catalogue operation %s through the registered runtime", async (command) => {
    const { authorization, token, session } = await capability();
    const runtime = await runtimes.getWorkspaceRuntime(PROJECT_ID, authorization);
    const result = await runtime.runCommand(await commandRequest(authorization, command));
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("synthetic successful check café 🚀\n");
    expect(sandboxLookup).toHaveBeenCalledWith(SANDBOX_ID);
    expect(sessionProcessLookup).toHaveBeenCalledWith(SANDBOX_ID);
    expect(adapter.calls.commands).toHaveLength(1);
    expect(adapter.calls.commands[0].request).toMatchObject({ runAsync: true, suppressInputEcho: true });
    expect(adapter.calls.inputs.map((entry) => entry.data)).toEqual(["START\n"]);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
    const records = await database.commandOperation.findMany();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ projectId: PROJECT_ID, workspaceId: SANDBOX_ID,
      commandKey: command, actorId: "frontend", status: "SUCCEEDED", exitCode: 0, cleanupConfirmed: true });
    expect(records[0].startedAt).toBeInstanceOf(Date);
    expect(records[0].completedAt).toBeInstanceOf(Date);
    const transmitted = JSON.stringify({ commands: adapter.submittedCommands, inputs: adapter.calls.inputs, records });
    expect(transmitted).not.toContain(token);
    expect(transmitted).not.toContain(session.id);
    expect(transmitted).not.toContain(process.env.DATABASE_URL);
    expect(transmitted).not.toContain(process.env.DAYTONA_API_KEY);
  });

  it("connects scoped approved agent execution to the same runtime and consumes its durable approval", async () => {
    const { authorization, authSession } = await capability();
    policy.setPolicyProfile("strict");
    const approval = await approvals.createPrivateCommandApproval(authorization, "npm test");
    await approvals.decidePrivateCommandApproval(authSession, approval.id, "approved");
    const context = { ...toolContext(authorization), approvalId: approval.id };
    expect(await tools.executeTool("run_command", { command: "npm test" }, context))
      .toMatchObject({ ok: true, workspaceChanged: true, data: { exitCode: 0 } });
    expect(await tools.executeTool("run_command", { command: "npm test" }, context))
      .toMatchObject({ ok: false, requiresApproval: true });
    expect(adapter.calls.commands).toHaveLength(1);
  });

  it("waits for a complete result across fragmented cumulative SDK transcript snapshots", async () => {
    const ready = "CR8OR-COMMAND/1 READY\n";
    const resultPrefix = "CR8OR-COMMAND/1 RESULT ";
    let snapshots = 0;
    adapter = createControlledCommandSessionAdapter(root, { transformLogs: (logs) => {
      if (!logs.stdout.includes(ready + resultPrefix)) return logs;
      const boundaries = [ready.length + 5, ready.length + resultPrefix.length - 1,
        ready.length + resultPrefix.length + 3];
      const boundary = boundaries[snapshots++];
      const stdout = boundary === undefined ? logs.stdout : logs.stdout.slice(0, boundary);
      return { stdout, stderr: "", output: stdout };
    } });
    const { authorization } = await capability();
    const result = await transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(authorization), authorization);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("synthetic successful check café 🚀");
    expect(snapshots).toBeGreaterThanOrEqual(4);
    expect(await database.commandOperation.findFirst()).toMatchObject({ status: "SUCCEEDED", cleanupConfirmed: true });
  });

  it("reports nonzero project-script exit as failure instead of successful agent execution", async () => {
    await fs.writeFile(path.join(root, "repo", "fixture.cjs"), "process.stderr.write('synthetic check failed\\n'); process.exitCode = 7;\n");
    const { authorization } = await capability();
    const result = await tools.executeTool("run_command", { command: "npm test" }, toolContext(authorization));
    expect(result).toMatchObject({ ok: false, workspaceChanged: true, data: { exitCode: 7 } });
    expect(await database.commandOperation.findFirst()).toMatchObject({ status: "FAILED", exitCode: 7 });
  });

  it("does not forward application credentials or inherited environment into npm scripts", async () => {
    setEnvironment("CR8OR_SYNTHETIC_COMMAND_SECRET", "synthetic-environment-must-not-reach-npm");
    await fs.writeFile(path.join(root, "repo", "fixture.cjs"), `
      const forbidden = ['DATABASE_URL', 'DIRECT_URL', 'DAYTONA_API_KEY', 'CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY', 'CR8OR_SYNTHETIC_COMMAND_SECRET'];
      if (forbidden.some((name) => process.env[name] !== undefined)) process.exit(21);
      process.stdout.write('application environment absent\\n');
    `);
    const { authorization } = await capability();
    const result = await transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(authorization), authorization);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("application environment absent");
    expect(JSON.stringify(adapter.submittedCommands)).not.toContain("synthetic-environment-must-not-reach-npm");
  });

  it.each(["revoked", "expired", "rotated", "disconnected"] as const)("stops output release and subsequent commands when authorization is %s during execution", async (state) => {
    await fs.writeFile(path.join(root, "repo", "fixture.cjs"), "process.stdout.write('must not release pending output\\n'); setTimeout(() => {}, 5000);\n");
    const controller = new AbortController();
    const { authorization, session } = await capability(undefined, controller.signal);
    const command = await commandRequest(authorization);
    let changed = false;
    adapter = createControlledCommandSessionAdapter(root, { onLogs: async () => {
      if (changed || !adapter.calls.inputs.some((entry) => entry.data === "START\n")) return;
      changed = true;
      if (state === "revoked") await sessions.revokeSession(session.id);
      if (state === "expired") await database.authSession.update({ where: { id: session.id }, data: {
        authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
      } });
      if (state === "rotated") await owners.rotateOwnerAccessCode("synthetic rotation during command");
      if (state === "disconnected") controller.abort();
    } });
    await expect(transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, command, authorization)).rejects.toMatchObject({ status: 401 });
    expect(changed).toBe(true);
    expect(adapter.calls.inputs.some((entry) => entry.data === "CANCEL\n")).toBe(true);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
    const created = adapter.calls.created.length;
    await expect(tools.executeTool("run_command", { command: "npm test" }, toolContext(authorization))).rejects.toMatchObject({ status: 401 });
    expect(adapter.calls.created).toHaveLength(created);
  }, 12_000);

  it("prevents duplicate dispatch of one opaque grant", async () => {
    const { authorization } = await capability();
    const command = await commandRequest(authorization);
    const results = await Promise.allSettled([
      transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, command, authorization),
      transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, command, authorization),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ status: 409 });
    expect(adapter.calls.inputs.filter((entry) => entry.data === "START\n")).toHaveLength(1);
    expect(await database.commandOperation.count()).toBe(1);
  });

  it("enforces shared workspace concurrency for independent owner contexts", async () => {
    await fs.writeFile(path.join(root, "repo", "fixture.cjs"), "setTimeout(() => process.stdout.write('done\\n'), 500);\n");
    const first = await capability();
    const second = await capability();
    const results = await Promise.allSettled([
      transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(first.authorization), first.authorization),
      transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(second.authorization), second.authorization),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(adapter.calls.commands).toHaveLength(1);
  });

  it("rejects excessive command output without returning partial output as success", async () => {
    await fs.writeFile(path.join(root, "repo", "fixture.cjs"), "process.stdout.write('x'.repeat(100000));\n");
    const { authorization } = await capability();
    const failure = await transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(authorization), authorization)
      .catch((error: unknown) => error);
    const record = await database.commandOperation.findFirstOrThrow();
    // This container's PID 1 may not reap killed npm descendants. Lack of group
    // disappearance must retain UNKNOWN instead of manufacturing confirmation.
    expect(["FAILED", "UNKNOWN"]).toContain(record.status);
    expect(failure).toMatchObject({ status: record.status === "UNKNOWN" ? 503 : 409 });
    if (record.status === "FAILED") expect(record.cancellationConfirmed).toBe(true);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
  });

  it("records a bounded remote timeout without claiming success", async () => {
    await fs.writeFile(path.join(root, "repo", "fixture.cjs"), "setTimeout(() => {}, 10000);\n");
    adapter = createControlledCommandSessionAdapter(root, { commandSeconds: 1 });
    const { authorization } = await capability();
    await expect(transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(authorization), authorization))
      .rejects.toMatchObject({ status: 503 });
    const record = await database.commandOperation.findFirstOrThrow();
    expect(["TIMED_OUT", "UNKNOWN"]).toContain(record.status);
    expect(record.cancellationConfirmed).toBe(record.status === "TIMED_OUT");
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
  }, 10_000);

  it("sanitizes provider failures and retains an unresolved shared slot", async () => {
    const { authorization, token } = await capability();
    vi.spyOn(adapter, "createSession").mockRejectedValue(new Error(`provider leaked ${token} synthetic provider secret`));
    const error = await transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(authorization), authorization)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain("synthetic provider secret");
    expect(await database.commandOperation.findFirst()).toMatchObject({ status: "UNKNOWN" });
  });

  it("does not claim safe cleanup when the provider cannot confirm deletion", async () => {
    const { authorization } = await capability();
    const originalDelete = adapter.deleteSession.bind(adapter);
    const deletion = vi.spyOn(adapter, "deleteSession").mockRejectedValue(new Error("synthetic provider credential must not be returned"));
    try {
      await expect(transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(authorization), authorization))
        .rejects.toMatchObject({ status: 503 });
      expect(await database.commandOperation.findFirst()).toMatchObject({ status: "UNKNOWN", cleanupConfirmed: false });
      await expect(transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, await commandRequest(authorization), authorization))
        .rejects.toMatchObject({ status: 409 });
      expect(adapter.calls.commands).toHaveLength(1);
    } finally {
      deletion.mockRestore();
      for (const sessionId of adapter.calls.created) await originalDelete(sessionId);
    }
  });

  it("fails closed if the shared coordination table is unavailable", async () => {
    const { authorization } = await capability();
    const command = await commandRequest(authorization);
    await database.$executeRawUnsafe('ALTER TABLE "CommandOperation" RENAME TO "CommandOperationUnavailable"');
    try {
      await expect(transport.privateCloudCommandSession(adapter, PROJECT_ID, SANDBOX_ID, command, authorization))
        .rejects.toMatchObject({ status: 503 });
      expect(adapter.calls.created).toEqual([]);
    } finally {
      await database.$executeRawUnsafe('ALTER TABLE "CommandOperationUnavailable" RENAME TO "CommandOperation"');
    }
  });

  it("retains the actual deployed command release restriction", async () => {
    const actual = await vi.importActual<typeof import("@/lib/workspace/private-cloud-command-availability")>("@/lib/workspace/private-cloud-command-availability");
    expect(() => actual.assertPrivateCloudCommandAvailable()).toThrow();
    expect(adapter.calls.created).toEqual([]);
  });
});
