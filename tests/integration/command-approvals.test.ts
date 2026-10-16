import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient, type OwnerCredential } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/security/auth";
import type { ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import type { ToolContext } from "@/lib/agents/tools";
import type { ValidatedCommandRequest } from "@/lib/workspace/runtime";

vi.mock("server-only", () => ({}));
// This suite never constructs a provider client or contacts a Daytona sandbox.
vi.mock("@daytona/sdk", () => ({ Daytona: class {} }));

function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "55432" || url.pathname !== "/cr8or_auth_test") {
    throw new Error("Command approval tests require the isolated local test database on port 55432.");
  }
  return url;
}

const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const suffix = randomBytes(8).toString("hex");
const schemaName = `command_approvals_${suffix}`;
const PROJECT_A = `approval-project-a-${suffix}`;
const PROJECT_B = `approval-project-b-${suffix}`;
const SANDBOX_A = `approval-sandbox-a-${suffix}`;
const SANDBOX_B = `approval-sandbox-b-${suffix}`;
const ORIGIN = "http://localhost:3000";
const environmentKeys = [
  "DATABASE_URL", "DIRECT_URL", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID",
  "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY",
  "CR8OR_FEATURE_AUTH_GUARD", "CR8OR_FEATURE_AUDIT_LOG", "CR8OR_WORKSPACE_MODE", "CR8OR_POLICY_PROFILE",
] as const;
const previousEnvironment = new Map(environmentKeys.map((name) => [name, process.env[name]]));
const previousGlobal = globalThis.prismaGlobal;
const previousPolicy = globalThis.__cr8orPolicyStore;
const previousApprovals = globalThis.__cr8orApprovalStore;

function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe.skipIf(!testUrl)("durable command approvals on isolated PostgreSQL", () => {
  let admin: PrismaClient;
  let database: PrismaClient;
  let secondDatabase: PrismaClient;
  let ownerFixture: OwnerCredential;
  let auth: typeof import("@/lib/security/auth");
  let sessions: typeof import("@/lib/security/session-store");
  let owners: typeof import("@/lib/security/owner-management");
  let execution: typeof import("@/lib/security/execution-context");
  let approvals: typeof import("@/lib/security/command-approvals");
  let commands: typeof import("@/lib/security/command-authorization");
  let policy: typeof import("@/lib/security/policy");
  let legacy: typeof import("@/lib/security/approvals");
  let route: typeof import("@/app/api/security/approvals/route");
  let secondAuth: typeof import("@/lib/security/auth");
  let secondExecution: typeof import("@/lib/security/execution-context");
  let secondApprovals: typeof import("@/lib/security/command-approvals");

  function request(cookie?: string, body?: unknown) {
    return new NextRequest(`${ORIGIN}/api/security/approvals`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { origin: ORIGIN, "x-cr8or-auth": "1", "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function initiatingSession(expiresIn = 60 * 60 * 1000) {
    const current = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    const created = await sessions.createOwnerSession({ credentialVersion: current.credentialVersion,
      authenticationMethod: "ACCESS_CODE", expiresAt: new Date(Date.now() + expiresIn) });
    const cookie = `cr8or-dev-session=${created.token}`;
    const authSession = await auth.resolveAuthSession(request(cookie), false);
    expect(authSession).not.toBeNull();
    return { ...created, cookie, authSession: authSession! };
  }

  async function capability(projectId = PROJECT_A, initiating?: Awaited<ReturnType<typeof initiatingSession>>) {
    const identity = initiating ?? await initiatingSession();
    const authorization = await execution.createExecutionAuthorization(identity.authSession, projectId);
    expect(authorization).toBeDefined();
    return { ...identity, authorization: authorization! };
  }

  async function approved(commandKey = "npm run lint") {
    const identity = await capability();
    const approval = await approvals.createPrivateCommandApproval(identity.authorization, commandKey);
    await approvals.decidePrivateCommandApproval(identity.authSession, approval.id, "approved");
    return { ...identity, approval };
  }

  function toolContext(authorization: ExecutionAuthorizationContext, approvalId?: string): ToolContext {
    return { authorization, projectId: authorization.projectId, workspaceRoot: "/unused-by-approval-test",
      actorId: "frontend", actorRole: "agent", requestId: "synthetic-scoped-approval", approvalId };
  }

  async function expireApproval(id: string) {
    const row = await database.commandApproval.findUniqueOrThrow({ where: { id } });
    await database.commandApproval.update({ where: { id }, data: {
      createdAt: new Date(Date.now() - 11 * 60_000), expiresAt: new Date(Date.now() - 60_000),
      ...(row.decidedAt ? { decidedAt: new Date(Date.now() - 10 * 60_000) } : {}),
      ...(row.consumedAt ? { consumedAt: new Date(Date.now() - 9 * 60_000) } : {}),
    } });
  }

  async function applyMigration(directory: string) {
    const sql = await readFile(path.join(process.cwd(), "prisma/migrations", directory, "migration.sql"), "utf8");
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
    for (const migration of ["0_init", "20250101000000_add_workspace_table", "20261015000000_authentication_foundation",
      "20261016000000_command_operations", "20261016010000_command_approvals", "20261016020000_git_operations"]) await applyMigration(migration);
    auth = await import("@/lib/security/auth");
    sessions = await import("@/lib/security/session-store");
    owners = await import("@/lib/security/owner-management");
    execution = await import("@/lib/security/execution-context");
    approvals = await import("@/lib/security/command-approvals");
    commands = await import("@/lib/security/command-authorization");
    policy = await import("@/lib/security/policy");
    legacy = await import("@/lib/security/approvals");
    route = await import("@/app/api/security/approvals/route");
    await owners.provisionOwner("1234");
    ownerFixture = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });

    // A separately loaded application graph uses a distinct connection pool and
    // mints its own authentic capabilities from the same cookie. Shared memory
    // cannot enforce one-use approvals for these two independent store instances.
    secondDatabase = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    globalThis.prismaGlobal = secondDatabase;
    vi.resetModules();
    secondAuth = await import("@/lib/security/auth");
    secondExecution = await import("@/lib/security/execution-context");
    secondApprovals = await import("@/lib/security/command-approvals");
    globalThis.prismaGlobal = database;
  }, 30_000);

  beforeEach(async () => {
    await database.commandApproval.deleteMany();
    await database.commandOperation.deleteMany();
    await database.authSession.deleteMany();
    await database.ownerCredential.deleteMany();
    await database.ownerCredential.create({ data: ownerFixture });
    await database.project.deleteMany();
    for (const [id, sandbox] of [[PROJECT_A, SANDBOX_A], [PROJECT_B, SANDBOX_B]]) {
      await database.project.create({ data: { id, name: "Synthetic registered approval project", description: "",
        framework: "Next.js", language: "TypeScript", workspaces: { create: {
          runtimeType: "cloud", state: "running", provider: "daytona", providerWorkspaceId: sandbox,
          repositoryUrl: "https://github.com/example/synthetic-approval", branch: "main",
        } } } });
    }
    policy.setPolicyProfile("balanced");
    globalThis.__cr8orApprovalStore = { records: [] };
  });

  afterEach(() => { vi.restoreAllMocks(); });

  afterAll(async () => {
    try {
      await database?.$disconnect();
      await secondDatabase?.$disconnect();
      if (admin) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin?.$disconnect();
      if (previousGlobal === undefined) delete globalThis.prismaGlobal;
      else globalThis.prismaGlobal = previousGlobal;
      if (previousPolicy === undefined) delete globalThis.__cr8orPolicyStore;
      else globalThis.__cr8orPolicyStore = previousPolicy;
      if (previousApprovals === undefined) delete globalThis.__cr8orApprovalStore;
      else globalThis.__cr8orApprovalStore = previousApprovals;
      for (const [name, value] of previousEnvironment) setEnvironment(name, value);
    }
  });

  it("persists server-resolved scope and presents its exact command, project and sandbox", async () => {
    const { authorization, session, cookie, token } = await capability();
    const response = await route.POST(request(cookie, { intent: "request", payload: {
      action: "commands.execute", projectId: PROJECT_A, commandKey: "npm run lint",
    } }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.approval.scope).toEqual({ ownerId: "owner", projectId: PROJECT_A,
      providerWorkspaceId: SANDBOX_A, commandKey: "npm run lint" });
    for (const field of [PROJECT_A, SANDBOX_A, "npm run lint"]) expect(body.approval.preview).toContain(field);
    const row = await database.commandApproval.findUniqueOrThrow({ where: { id: body.approval.id } });
    expect(row).toMatchObject({ ownerId: "owner", sessionId: session.id, credentialVersion: ownerFixture.credentialVersion,
      projectId: PROJECT_A, workspaceRecordId: authorization.workspace.id, providerWorkspaceId: SANDBOX_A,
      commandKey: "npm run lint", status: "PENDING", consumedAt: null });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(10 * 60_000);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(session.expiresAt.getTime());
    const encoded = JSON.stringify(body);
    for (const secret of [session.id, token, ownerFixture.accessCodeHash]) expect(encoded).not.toContain(secret);
  });

  it("caps approval lifetime at the initiating session expiration", async () => {
    const identity = await capability(PROJECT_A, await initiatingSession(60_000));
    const approval = await approvals.createPrivateCommandApproval(identity.authorization, "npm run lint");
    expect(new Date(approval.expiresAt).getTime()).toBe(identity.session.expiresAt.getTime());
  });

  it.each(["npm test", "npm run lint -- --fix", "npm run lint; id"])("does not spend lint approval on %s", async (otherCommand) => {
    const { authorization, approval } = await approved();
    const result = await commands.authorizeDevelopmentCommand(toolContext(authorization, approval.id), otherCommand)
      .catch((error: unknown) => error);
    expect(result).not.toMatchObject({ allowed: true });
    expect((await database.commandApproval.findUniqueOrThrow({ where: { id: approval.id } })).consumedAt).toBeNull();
    expect(await approvals.consumePrivateCommandApproval(authorization, "npm run lint", approval.id, randomUUID(), "frontend")).toBe(true);
  });

  it("does not transfer a project A approval to project B in the same genuine owner session", async () => {
    const identity = await approved();
    const projectB = await capability(PROJECT_B, identity);
    expect(await approvals.consumePrivateCommandApproval(projectB.authorization, "npm run lint", identity.approval.id, randomUUID(), "frontend")).toBe(false);
    expect((await database.commandApproval.findUniqueOrThrow({ where: { id: identity.approval.id } })).consumedAt).toBeNull();
  });

  it("rejects old and freshly resolved capabilities after canonical Daytona remapping", async () => {
    const identity = await approved();
    await database.workspace.updateMany({ where: { projectId: PROJECT_A }, data: { providerWorkspaceId: `remapped-${suffix}` } });
    await expect(approvals.consumePrivateCommandApproval(identity.authorization, "npm run lint", identity.approval.id, randomUUID(), "frontend"))
      .rejects.toMatchObject({ status: 409 });
    const remapped = await execution.createExecutionAuthorization(identity.authSession, PROJECT_A);
    expect(await approvals.consumePrivateCommandApproval(remapped!, "npm run lint", identity.approval.id, randomUUID(), "frontend")).toBe(false);
    expect((await database.commandApproval.findUniqueOrThrow({ where: { id: identity.approval.id } })).consumedAt).toBeNull();
  });

  it("rejects replacing the registration record even when its provider identifier is reused", async () => {
    const identity = await approved();
    await database.workspace.deleteMany({ where: { projectId: PROJECT_A } });
    await database.workspace.create({ data: { projectId: PROJECT_A, runtimeType: "cloud", state: "running",
      provider: "daytona", providerWorkspaceId: SANDBOX_A, repositoryUrl: "https://github.com/example/synthetic-approval", branch: "main" } });
    const replacement = await execution.createExecutionAuthorization(identity.authSession, PROJECT_A);
    expect(await approvals.consumePrivateCommandApproval(replacement!, "npm run lint", identity.approval.id, randomUUID(), "frontend")).toBe(false);
  });

  it("atomically records one-time consumption and the exact authorized operation", async () => {
    const { authorization, approval } = await approved();
    const operationId = randomUUID();
    expect(await approvals.consumePrivateCommandApproval(authorization, "npm run lint", approval.id, operationId, "frontend")).toBe(true);
    expect(await approvals.consumePrivateCommandApproval(authorization, "npm run lint", approval.id, randomUUID(), "frontend")).toBe(false);
    expect(await approvals.consumePrivateCommandApproval(authorization, "npm run lint", approval.id, operationId, "frontend")).toBe(false);
    const row = await database.commandApproval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(row).toMatchObject({ status: "APPROVED", consumedOperationId: operationId, consumedActorId: "frontend" });
    expect(row.consumedAt).toBeInstanceOf(Date);
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(await approvals.validateConsumedPrivateCommandApproval(authorization, "npm run lint", approval.id, operationId, "frontend")).toBe(true);
    expect(await approvals.validateConsumedPrivateCommandApproval(authorization, "npm test", approval.id, operationId, "frontend")).toBe(false);
    expect(await approvals.validateConsumedPrivateCommandApproval(authorization, "npm run lint", approval.id, randomUUID(), "frontend")).toBe(false);
    expect(await approvals.validateConsumedPrivateCommandApproval(authorization, "npm run lint", approval.id, operationId, "backend")).toBe(false);
  });

  it("allows only one concurrent consumption across independent application instances and connection pools", async () => {
    const identity = await approved();
    const otherSession = await secondAuth.resolveAuthSession(request(identity.cookie), false);
    expect(otherSession).not.toBeNull();
    const otherContext = await secondExecution.createExecutionAuthorization(otherSession!, PROJECT_A);
    expect(otherContext).toBeDefined();
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => index % 2
      ? secondApprovals.consumePrivateCommandApproval(otherContext!, "npm run lint", identity.approval.id, randomUUID(), "frontend")
      : approvals.consumePrivateCommandApproval(identity.authorization, "npm run lint", identity.approval.id, randomUUID(), "frontend")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await database.commandApproval.count({ where: { consumedAt: { not: null } } })).toBe(1);
  });

  it("does not reuse one operation receipt to consume another approval", async () => {
    const identity = await approved();
    const additional = await approvals.createPrivateCommandApproval(identity.authorization, "npm run lint");
    await approvals.decidePrivateCommandApproval(identity.authSession, additional.id, "approved");
    const operationId = randomUUID();
    expect(await approvals.consumePrivateCommandApproval(identity.authorization, "npm run lint", identity.approval.id, operationId, "frontend")).toBe(true);
    expect(await approvals.consumePrivateCommandApproval(identity.authorization, "npm run lint", additional.id, operationId, "frontend")).toBe(false);
    expect((await database.commandApproval.findUniqueOrThrow({ where: { id: additional.id } })).consumedAt).toBeNull();
  });

  it.each(["pending", "denied", "revoked", "expired"] as const)("does not consume a %s approval", async (status) => {
    const identity = await capability();
    const approval = await approvals.createPrivateCommandApproval(identity.authorization, "npm run lint");
    if (status === "denied" || status === "revoked") await approvals.decidePrivateCommandApproval(identity.authSession, approval.id, status);
    if (status === "expired") {
      await approvals.decidePrivateCommandApproval(identity.authSession, approval.id, "approved");
      await expireApproval(approval.id);
    }
    expect(await approvals.consumePrivateCommandApproval(identity.authorization, "npm run lint", approval.id, randomUUID(), "frontend")).toBe(false);
    expect((await database.commandApproval.findUniqueOrThrow({ where: { id: approval.id } })).consumedAt).toBeNull();
  });

  it("does not allow another authenticated owner device to decide or consume the originating session's approval", async () => {
    const first = await capability();
    const approval = await approvals.createPrivateCommandApproval(first.authorization, "npm run lint");
    const second = await capability();
    await expect(approvals.decidePrivateCommandApproval(second.authSession, approval.id, "approved")).rejects.toMatchObject({ status: 409 });
    await approvals.decidePrivateCommandApproval(first.authSession, approval.id, "approved");
    expect(await approvals.consumePrivateCommandApproval(second.authorization, "npm run lint", approval.id, randomUUID(), "frontend")).toBe(false);
    expect(await approvals.consumePrivateCommandApproval(first.authorization, "npm run lint", approval.id, randomUUID(), "frontend")).toBe(true);
  });

  it.each(["revoked", "expired", "rotated", "revoke-all"] as const)("rejects approvals after initiating session security state becomes %s", async (state) => {
    const identity = await approved();
    if (state === "revoked") await sessions.revokeSession(identity.session.id);
    if (state === "expired") await database.authSession.update({ where: { id: identity.session.id }, data: {
      authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
    } });
    if (state === "rotated") await owners.rotateOwnerAccessCode("synthetic replacement 1234");
    if (state === "revoke-all") await sessions.revokeAllOwnerSessions();
    await expect(approvals.consumePrivateCommandApproval(identity.authorization, "npm run lint", identity.approval.id, randomUUID(), "frontend"))
      .rejects.toMatchObject({ status: 401 });
    const fresh = await capability();
    expect(await approvals.consumePrivateCommandApproval(fresh.authorization, "npm run lint", identity.approval.id, randomUUID(), "frontend")).toBe(false);
    expect((await database.commandApproval.findUniqueOrThrow({ where: { id: identity.approval.id } })).consumedAt).toBeNull();
  });

  it("rejects fabricated owner proofs and copied execution contexts", async () => {
    const identity = await approved();
    const forged = { userId: "owner", role: "owner", provider: "private-session", authenticated: true } as AuthSession;
    await expect(approvals.decidePrivateCommandApproval(forged, identity.approval.id, "revoked")).rejects.toMatchObject({ status: 401 });
    await expect(approvals.createPrivateCommandApproval({ ...identity.authorization } as ExecutionAuthorizationContext, "npm run lint"))
      .rejects.toMatchObject({ status: 401 });
  });

  it.each(["balanced", "strict"] as const)("rejects action-only legacy approvals under %s policy without consuming them", async (profile) => {
    policy.setPolicyProfile(profile);
    const { authorization } = await capability();
    const generic = legacy.requestApproval({ action: "commands.execute", title: `Approve ${PROJECT_A}`,
      preview: `npm run lint inside ${SANDBOX_A}`, requestedBy: "owner", requestedRole: "owner" });
    legacy.decideApproval({ id: generic.id, decision: "approved", decidedBy: "owner", decidedRole: "owner" });
    expect(await commands.authorizeDevelopmentCommand(toolContext(authorization, generic.id), "npm run lint"))
      .toMatchObject({ allowed: false, requiresApproval: true });
    expect(legacy.listApprovals()[0].consumedAt).toBeUndefined();
    expect(await database.commandApproval.count()).toBe(0);
  });

  it.each(["balanced", "strict"] as const)("mints a grant for only its intended scoped command under %s policy", async (profile) => {
    policy.setPolicyProfile(profile);
    const identity = await approved();
    const result = await commands.authorizeDevelopmentCommand(toolContext(identity.authorization, identity.approval.id), "npm run lint");
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error("Expected scoped test approval to authorize its command.");
    const command = { command: "npm run lint", commandKey: "npm run lint", rules: [{ kind: "exact", value: "npm run lint" }],
      commandAuthorization: result.authorization } satisfies ValidatedCommandRequest;
    const receipt = await commands.validateCommandAuthorization(result.authorization, identity.authorization, command);
    expect(receipt.commandKey).toBe("npm run lint");
    expect((await database.commandApproval.findUniqueOrThrow({ where: { id: identity.approval.id } })).consumedOperationId).toBe(receipt.operationId);
    await expect(commands.validateCommandAuthorization(result.authorization, identity.authorization,
      { ...command, command: "npm test", commandKey: "npm test", rules: [{ kind: "exact", value: "npm test" }] })).rejects.toMatchObject({ status: 403 });
  });

  it.each(["revoked", "expired"] as const)("invalidates an already minted grant when its approval is %s", async (state) => {
    const identity = await approved();
    const result = await commands.authorizeDevelopmentCommand(toolContext(identity.authorization, identity.approval.id), "npm run lint");
    if (!result.allowed) throw new Error("Expected scoped test approval to authorize its command.");
    if (state === "revoked") await approvals.decidePrivateCommandApproval(identity.authSession, identity.approval.id, "revoked");
    else await expireApproval(identity.approval.id);
    await expect(commands.validateCommandAuthorization(result.authorization, identity.authorization, {
      command: "npm run lint", commandKey: "npm run lint", rules: [{ kind: "exact", value: "npm run lint" }], commandAuthorization: result.authorization,
    })).rejects.toMatchObject({ status: 403 });
    const record = await database.commandApproval.findUniqueOrThrow({ where: { id: identity.approval.id } });
    expect(record.consumedAt).toBeInstanceOf(Date);
    expect(record.consumedOperationId).not.toBeNull();
  });

  it("preserves explicit autonomous behavior while retaining real authentication and release restrictions", async () => {
    policy.setPolicyProfile("autonomous");
    const { authorization } = await capability();
    expect(await commands.authorizeDevelopmentCommand(toolContext(authorization), "npm run lint")).toMatchObject({ allowed: true });
    await expect(commands.authorizeDevelopmentCommand({ ...toolContext(authorization), authorization: undefined }, "npm run lint"))
      .rejects.toMatchObject({ status: 401 });
    const release = await import("@/lib/workspace/private-cloud-command-availability");
    expect(() => release.assertPrivateCloudCommandAvailable()).toThrow();
    const cloudWriteRelease = await import("@/lib/workspace/private-cloud-write-availability");
    expect(() => cloudWriteRelease.assertPrivateCloudWriteTransportAvailable()).toThrow();
  });

  it.each([
    { ownerId: "owner" }, { sessionId: "forged-session" }, { credentialVersion: 1 },
    { providerWorkspaceId: SANDBOX_B }, { workspaceId: SANDBOX_B }, { status: "approved" },
    { title: "npm run lint", preview: "Safe-looking but untrusted approval text" },
    { scope: { ownerId: "owner", projectId: PROJECT_B, providerWorkspaceId: SANDBOX_B, commandKey: "npm test" } },
  ])("rejects client-supplied scope or presentation fields %j", async (forged) => {
    const { cookie } = await initiatingSession();
    const response = await route.POST(request(cookie, { intent: "request", payload: {
      action: "commands.execute", projectId: PROJECT_A, commandKey: "npm run lint", ...forged,
    } }));
    expect(response.status).toBe(400);
    expect(await database.commandApproval.count()).toBe(0);
  });

  it.each([undefined, `cr8or-dev-session=${randomBytes(32).toString("base64url")}`])("requires genuine cookies for the approval HTTP workflow", async (cookie) => {
    const response = await route.POST(request(cookie, { intent: "request", payload: {
      action: "commands.execute", projectId: PROJECT_A, commandKey: "npm run lint",
    } }));
    expect(response.status).toBe(401);
    expect(await database.commandApproval.count()).toBe(0);
  });

  it.each([
    { projectId: "unregistered-project", commandKey: "npm run lint", status: 404 },
    { projectId: PROJECT_A, commandKey: "npm run lint -- --fix", status: 400 },
  ])("does not construct approval scope for invalid operation $commandKey / $projectId", async ({ projectId, commandKey, status }) => {
    const { cookie } = await initiatingSession();
    const response = await route.POST(request(cookie, { intent: "request", payload: {
      action: "commands.execute", projectId, commandKey,
    } }));
    expect(response.status).toBe(status);
    expect(await database.commandApproval.count()).toBe(0);
  });

  it("serves durable decisions and listings while preserving unrelated legacy workflows", async () => {
    const { cookie } = await initiatingSession();
    const createdResponse = await route.POST(request(cookie, { intent: "request", payload: {
      action: "commands.execute", projectId: PROJECT_A, commandKey: "npm run lint",
    } }));
    const { approval } = await createdResponse.json();
    const decision = await route.POST(request(cookie, { intent: "decide", payload: { id: approval.id, decision: "approved" } }));
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe("approved");
    const unrelated = legacy.requestApproval({ action: "files.write", title: "Unrelated file write", preview: "Synthetic file write",
      requestedBy: "owner", requestedRole: "owner" });
    const actionOnly = legacy.requestApproval({ action: "commands.execute", title: "Legacy action only", preview: "Untrusted command preview",
      requestedBy: "owner", requestedRole: "owner" });
    const response = await route.GET(request(cookie));
    expect(response.status).toBe(200);
    const ids = (await response.json()).approvals.map((entry: { id: string }) => entry.id);
    expect(ids).toContain(approval.id);
    expect(ids).toContain(unrelated.id);
    expect(ids).not.toContain(actionOnly.id);
    const unchanged = await route.POST(request(cookie, { intent: "decide", payload: { id: unrelated.id, decision: "approved" } }));
    expect(unchanged.status).toBe(200);
    expect(legacy.consumeApprovalForAction(unrelated.id, "files.write")).toBe(true);
  });

  it("denies all approval database operations with sanitized errors when persistence is unavailable", async () => {
    const identity = await approved();
    await database.$executeRawUnsafe('ALTER TABLE "CommandApproval" RENAME TO "CommandApprovalUnavailable"');
    try {
      await expect(approvals.consumePrivateCommandApproval(identity.authorization, "npm run lint", identity.approval.id, randomUUID(), "frontend"))
        .rejects.toMatchObject({ status: 503 });
      await expect(approvals.createPrivateCommandApproval(identity.authorization, "npm run lint")).rejects.toMatchObject({ status: 503 });
      await expect(approvals.decidePrivateCommandApproval(identity.authSession, identity.approval.id, "revoked")).rejects.toMatchObject({ status: 503 });
      const response = await route.GET(request(identity.cookie));
      expect(response.status).toBe(503);
      const output = await response.text();
      expect(output).not.toContain("CommandApprovalUnavailable");
      expect(output).not.toContain(process.env.DATABASE_URL);
      expect(output).not.toContain(identity.token);
    } finally {
      await database.$executeRawUnsafe('ALTER TABLE "CommandApprovalUnavailable" RENAME TO "CommandApproval"');
    }
  });
});
