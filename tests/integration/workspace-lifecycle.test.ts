import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PrismaClient, type OwnerCredential } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/lib/security/auth";
import type { WorkspaceLifecycleRequest, WorkspaceLifecycleScope } from "@/lib/security/workspace-lifecycle-catalogue";
import type { LifecycleProvider, LifecycleResource } from "@/lib/workspace/private-lifecycle-provider";
import type { RepositoryInitializationTransport } from "@/lib/workspace/private-workspace-lifecycle";

vi.mock("server-only", () => ({}));
// Real PostgreSQL and synthetic registrations, with no live provider available.
vi.mock("@daytona/sdk", () => ({ Daytona: class {} }));

function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "55432" || url.pathname !== "/cr8or_auth_test") {
    throw new Error("Lifecycle tests require the isolated local database on port 55432.");
  }
  return url;
}
const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const suffix = randomBytes(8).toString("hex");
const schemaName = `workspace_lifecycle_${suffix}`;
const PROJECT_A = `lifecycle-project-a-${suffix}`, PROJECT_B = `lifecycle-project-b-${suffix}`;
const SANDBOX_A = `lifecycle-sandbox-a-${suffix}`, SANDBOX_B = `lifecycle-sandbox-b-${suffix}`;
const REPOSITORY_A = "synthetic-owner/repository-a", REPOSITORY_B = "synthetic-owner/repository-b";
const ORIGIN = "http://localhost:3000";
const environmentKeys = ["DATABASE_URL", "DIRECT_URL", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID",
  "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY",
  "CR8OR_FEATURE_AUTH_GUARD", "CR8OR_FEATURE_AUDIT_LOG", "CR8OR_WORKSPACE_MODE", "CR8OR_POLICY_PROFILE"] as const;
const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
const previousGlobal = globalThis.prismaGlobal, previousPolicy = globalThis.__cr8orPolicyStore;
function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

describe.skipIf(!testUrl)("workspace lifecycle on isolated PostgreSQL", () => {
  let admin: PrismaClient, database: PrismaClient, secondDatabase: PrismaClient, ownerFixture: OwnerCredential;
  let auth: typeof import("@/lib/security/auth");
  let sessions: typeof import("@/lib/security/session-store");
  let owners: typeof import("@/lib/security/owner-management");
  let policy: typeof import("@/lib/security/policy");
  let catalogue: typeof import("@/lib/security/workspace-lifecycle-catalogue");
  let store: typeof import("@/lib/security/workspace-lifecycle-store");
  let secondStore: typeof import("@/lib/security/workspace-lifecycle-store");
  let service: typeof import("@/lib/workspace/private-workspace-lifecycle");
  let providerHelpers: typeof import("@/lib/workspace/private-lifecycle-provider");

  function request(cookie?: string) {
    return new NextRequest(`${ORIGIN}/api/workspace/cloud`, { headers: cookie ? { cookie } : {} });
  }
  async function initiatingSession(expiresIn = 60 * 60 * 1_000) {
    const current = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    const created = await sessions.createOwnerSession({ credentialVersion: current.credentialVersion,
      authenticationMethod: "ACCESS_CODE", expiresAt: new Date(Date.now() + expiresIn) });
    const cookie = `cr8or-dev-session=${created.token}`;
    const authSession = await auth.resolveAuthSession(request(cookie), false);
    expect(authSession).not.toBeNull();
    return { ...created, cookie, authSession: authSession! };
  }
  async function owner() {
    const identity = await initiatingSession();
    const binding = await auth.resolvePrivateOwnerBinding(identity.authSession);
    expect(binding).not.toBeNull();
    return { ...identity, binding: binding! };
  }
  async function registeredScope(action: "start" | "stop" = "start", projectId = PROJECT_A): Promise<WorkspaceLifecycleScope> {
    const project = await database.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspaces: true } });
    const workspace = project.workspaces[0];
    return catalogue.validateWorkspaceLifecycleScope({ version: 1, ownerId: "owner", action, projectId,
      workspaceRecordId: workspace.id, providerWorkspaceId: workspace.providerWorkspaceId, projectName: project.name,
      repositoryKey: projectId === PROJECT_A ? REPOSITORY_A : REPOSITORY_B,
      repositoryUrl: workspace.repositoryUrl, branch: workspace.branch });
  }
  function creationScope(binding: { sessionId: string }, idempotencyKey = randomUUID()): WorkspaceLifecycleScope {
    return catalogue.validateWorkspaceLifecycleScope({ version: 1, ownerId: "owner", action: "create",
      ...catalogue.reservedLifecycleIdentity(binding.sessionId, idempotencyKey), providerWorkspaceId: null,
      projectName: "Synthetic newly provisioned project", repositoryKey: null, repositoryUrl: null, branch: null });
  }
  async function reserved(action: "create" | "start" | "stop" = "create") {
    const identity = await owner(); const idempotencyKey = randomUUID();
    const scope = action === "create" ? creationScope(identity.binding, idempotencyKey) : await registeredScope(action);
    const approval = await store.createLifecycleApproval(identity.binding, scope);
    await store.decideLifecycleApproval(identity.binding, approval.id, "approved");
    const reservation = await store.reserveLifecycleOperation(identity.binding, scope, { idempotencyKey,
      approvalId: approval.id, requiresApproval: true });
    return { ...identity, scope, idempotencyKey, approval, ...reservation };
  }
  function resource(id = SANDBOX_A, state: LifecycleResource["state"] = "started"): LifecycleResource {
    return { id, state, labels: {}, isolationVerified: true };
  }
  function controlledProvider(): LifecycleProvider {
    const created = new Map<string, LifecycleResource>();
    return {
      create: vi.fn(async (identity, _signal, beforeDispatch) => {
        await beforeDispatch?.();
        const value = { ...resource(`synthetic-${identity.operationId}`), labels: providerHelpers.lifecycleCreationLabels(identity) };
        created.set(value.id, value); return value;
      }),
      inspect: vi.fn(async id => created.get(id) ?? resource(id, "stopped")),
      start: vi.fn(async (id, _signal, beforeDispatch) => { await beforeDispatch?.(); return resource(id); }),
      stop: vi.fn(async (id, _signal, beforeDispatch) => { await beforeDispatch?.(); return resource(id, "stopped"); }),
      findCreated: vi.fn(async identity => [...created.values()].filter(value => value.labels["cr8or-operation"] === identity.operationId)),
    };
  }
  const createRequest = (): WorkspaceLifecycleRequest => ({ action: "create", projectName: "Created through trusted service", idempotencyKey: randomUUID() });
  const startRequest = (): WorkspaceLifecycleRequest => ({ action: "start", projectId: PROJECT_A, idempotencyKey: randomUUID() });
  async function approvedServiceRequest(request: WorkspaceLifecycleRequest = createRequest()) {
    const identity = await owner();
    const approval = await service.prepareWorkspaceLifecycle(identity.authSession, request);
    await service.decideWorkspaceLifecycle(identity.authSession, approval.approvalId, "approve");
    return { ...identity, approval, request };
  }
  function repositoryTransport(): RepositoryInitializationTransport {
    const verified = async (scope: WorkspaceLifecycleScope, _id: string, _sandbox: string, revalidate: () => Promise<void>) => {
      await revalidate();
      return { status: "complete" as const, repositoryKey: scope.repositoryKey!, branch: scope.branch!,
        head: scope.initialization!.expectedHead, historyVerified: true };
    };
    return { resolveHead: vi.fn(async (_repository, revalidate) => { await revalidate(); return "a".repeat(40); }),
      prepare: vi.fn(async (_scope, revalidate) => { await revalidate(); }), initialize: vi.fn(verified), inspect: vi.fn(verified) };
  }
  async function approvedClone(transport = repositoryTransport()) {
    const identity = await owner();
    const request = { action: "clone" as const, repositoryUrl: "https://github.com/synthetic-owner/new-repository",
      branch: "main", idempotencyKey: randomUUID() };
    const approval = await service.prepareWorkspaceLifecycleWithRepository(identity.authSession, request, transport);
    await service.decideWorkspaceLifecycle(identity.authSession, approval.approvalId, "approve");
    return { ...identity, approval, request, transport };
  }
  async function migrate(directory: string) {
    const sql = await readFile(path.join(process.cwd(), "prisma/migrations", directory, "migration.sql"), "utf8");
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";").map(value => value.trim())
      .filter(value => value && !/^(BEGIN|COMMIT)$/i.test(value));
    await database.$transaction(async tx => { for (const statement of statements) await tx.$executeRawUnsafe(statement); });
  }
  beforeAll(async () => {
    setEnvironment("NODE_ENV", "test");
    for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID", "CR8OR_WORKSPACE_MODE"]) setEnvironment(key, undefined);
    setEnvironment("CR8OR_PRIVATE_AUTH_ENABLED", "true");
    setEnvironment("CR8OR_PRIVATE_AUTH_ORIGIN", ORIGIN);
    setEnvironment("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", randomBytes(32).toString("base64url"));
    setEnvironment("CR8OR_FEATURE_AUTH_GUARD", "false"); setEnvironment("CR8OR_FEATURE_AUDIT_LOG", "false");
    const url = new URL(testUrl!); url.search = "";
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    url.searchParams.set("schema", schemaName); url.searchParams.set("connection_limit", "5");
    setEnvironment("DATABASE_URL", url.toString()); setEnvironment("DIRECT_URL", url.toString());
    delete globalThis.prismaGlobal; vi.resetModules();
    database = (await import("@/lib/db/prisma")).prisma;
    for (const entry of (await readdir(path.join(process.cwd(), "prisma/migrations"), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) await migrate(entry);
    auth = await import("@/lib/security/auth"); sessions = await import("@/lib/security/session-store");
    owners = await import("@/lib/security/owner-management"); policy = await import("@/lib/security/policy");
    catalogue = await import("@/lib/security/workspace-lifecycle-catalogue");
    store = await import("@/lib/security/workspace-lifecycle-store");
    service = await import("@/lib/workspace/private-workspace-lifecycle");
    providerHelpers = await import("@/lib/workspace/private-lifecycle-provider");
    await owners.provisionOwner("synthetic lifecycle fixture code");
    ownerFixture = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    secondDatabase = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    globalThis.prismaGlobal = secondDatabase; vi.resetModules();
    secondStore = await import("@/lib/security/workspace-lifecycle-store");
    globalThis.prismaGlobal = database;
  }, 30_000);
  beforeEach(async () => {
    await database.$executeRaw`DELETE FROM "WorkspaceLifecycleOperation"`;
    await database.$executeRaw`DELETE FROM "WorkspaceLifecycleApproval"`;
    await database.authSession.deleteMany(); await database.ownerCredential.deleteMany();
    await database.ownerCredential.create({ data: ownerFixture }); await database.project.deleteMany();
    for (const [id, sandbox, repository] of [[PROJECT_A, SANDBOX_A, REPOSITORY_A], [PROJECT_B, SANDBOX_B, REPOSITORY_B]]) {
      await database.project.create({ data: { id, name: "Synthetic lifecycle project", description: "", framework: "Next.js", language: "TypeScript",
        repository: `https://github.com/${repository}`, workspaces: { create: { runtimeType: "cloud", state: "stopped", provider: "daytona",
          providerWorkspaceId: sandbox, repositoryUrl: `https://github.com/${repository}.git`, branch: "main" } } } });
    }
    policy.setPolicyProfile("balanced");
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try {
      await database?.$disconnect(); await secondDatabase?.$disconnect();
      if (admin) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin?.$disconnect();
      if (previousGlobal === undefined) delete globalThis.prismaGlobal; else globalThis.prismaGlobal = previousGlobal;
      if (previousPolicy === undefined) delete globalThis.__cr8orPolicyStore; else globalThis.__cr8orPolicyStore = previousPolicy;
      for (const [key, value] of previousEnvironment) setEnvironment(key, value);
    }
  });

  it("persists exact server scope with a ten-minute device and credential-generation binding", async () => {
    const identity = await owner(), scope = await registeredScope();
    const approval = await store.createLifecycleApproval(identity.binding, scope);
    const [row] = await database.$queryRaw<Array<{ sessionId: string; credentialVersion: number; scope: WorkspaceLifecycleScope;
      scopeDigest: string; createdAt: Date; expiresAt: Date; consumedAt: Date | null }>>`
      SELECT * FROM "WorkspaceLifecycleApproval" WHERE "id" = ${approval.id}::uuid`;
    expect(row).toMatchObject({ sessionId: identity.session.id, credentialVersion: ownerFixture.credentialVersion,
      scope, scopeDigest: catalogue.workspaceLifecycleScopeDigest(scope), consumedAt: null });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(10 * 60 * 1_000);
    for (const secret of [identity.token, identity.session.id, ownerFixture.accessCodeHash]) expect(JSON.stringify(approval)).not.toContain(secret);
    expect(approval.scope).toEqual(scope);
  });
  it("caps approval validity at the originating owner session expiration", async () => {
    const identity = await initiatingSession(60_000), binding = await auth.resolvePrivateOwnerBinding(identity.authSession);
    const approval = await store.createLifecycleApproval(binding!, await registeredScope());
    const [row] = await database.$queryRaw<Array<{ expiresAt: Date }>>`SELECT "expiresAt" FROM "WorkspaceLifecycleApproval" WHERE "id" = ${approval.id}::uuid`;
    expect(row.expiresAt.getTime()).toBe(identity.session.expiresAt.getTime());
  });
  it("returns the same durable reservation for an identical idempotent retry", async () => {
    const identity = await reserved();
    const repeated = await secondStore.reserveLifecycleOperation(identity.binding, identity.scope,
      { idempotencyKey: identity.idempotencyKey, approvalId: identity.approval.id, requiresApproval: true });
    expect(repeated.reused).toBe(true); expect(repeated.operation.id).toBe(identity.operation.id);
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(1);
  });
  it("rejects reuse of an idempotency key for different operation scope", async () => {
    const identity = await reserved();
    await expect(secondStore.reserveLifecycleOperation(identity.binding, { ...identity.scope, projectName: "Substituted project" },
      { idempotencyKey: identity.idempotencyKey, approvalId: identity.approval.id, requiresApproval: true })).rejects.toMatchObject({ status: 409 });
  });
  it("consumes a lifecycle approval once across separate application connection pools", async () => {
    const identity = await owner(), scope = await registeredScope();
    const approval = await store.createLifecycleApproval(identity.binding, scope);
    await store.decideLifecycleApproval(identity.binding, approval.id, "approved");
    const outcomes = await Promise.allSettled([store, secondStore].map(instance => instance.reserveLifecycleOperation(identity.binding, scope,
      { idempotencyKey: randomUUID(), approvalId: approval.id, requiresApproval: true })));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    const [row] = await database.$queryRaw<Array<{ consumedOperationId: string | null; consumedAt: Date | null }>>`
      SELECT "consumedOperationId", "consumedAt" FROM "WorkspaceLifecycleApproval" WHERE "id" = ${approval.id}::uuid`;
    expect(row.consumedOperationId).toEqual(expect.any(String)); expect(row.consumedAt).toBeInstanceOf(Date);
  });
  it("allows exactly one dispatch claim for a reservation across instances", async () => {
    const identity = await reserved();
    const outcomes = await Promise.allSettled([store, secondStore].map(instance => instance.markLifecycleDispatched(identity.binding, identity.operation.id)));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "DISPATCHED", attempts: 1 });
  });
  it.each(["projectId", "workspaceRecordId", "providerWorkspaceId", "action", "repositoryKey", "branch"] as const)(
    "cannot consume an approval after scope field %s changes", async key => {
      const identity = await owner(), scope = await registeredScope();
      const approval = await store.createLifecycleApproval(identity.binding, scope);
      await store.decideLifecycleApproval(identity.binding, approval.id, "approved");
      const changed = { ...scope, [key]: key === "action" ? "stop" : `different-${key}` };
      await expect(store.reserveLifecycleOperation(identity.binding, changed, { idempotencyKey: randomUUID(),
        approvalId: approval.id, requiresApproval: true })).rejects.toBeDefined();
      const [row] = await database.$queryRaw<Array<{ consumedAt: Date | null }>>`SELECT "consumedAt" FROM "WorkspaceLifecycleApproval" WHERE "id" = ${approval.id}::uuid`;
      expect(row.consumedAt).toBeNull();
    });
  it.each(["PENDING", "DENIED", "REVOKED", "EXPIRED"])("rejects %s approval", async status => {
    const identity = await owner(), scope = await registeredScope();
    const approval = await store.createLifecycleApproval(identity.binding, scope);
    if (status === "DENIED") await store.decideLifecycleApproval(identity.binding, approval.id, "denied");
    if (status === "REVOKED") await store.decideLifecycleApproval(identity.binding, approval.id, "revoked");
    if (status === "EXPIRED") await database.$executeRaw`UPDATE "WorkspaceLifecycleApproval"
      SET "createdAt" = NOW() - INTERVAL '11 minutes', "expiresAt" = NOW() - INTERVAL '1 minute' WHERE "id" = ${approval.id}::uuid`;
    await expect(store.reserveLifecycleOperation(identity.binding, scope, { idempotencyKey: randomUUID(),
      approvalId: approval.id, requiresApproval: true })).rejects.toBeDefined();
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(0);
  });
  it("rejects another owner device even when its authenticated owner identity matches", async () => {
    const identity = await reserved(), other = await owner();
    await expect(secondStore.markLifecycleDispatched(other.binding, identity.operation.id)).rejects.toBeDefined();
    await expect(secondStore.readLifecycleOperation(other.binding, identity.operation.id)).resolves.toBeNull();
  });
  it.each(["revoke", "expire", "rotate"])("rejects a stored initiating session after %s", async mode => {
    const identity = await reserved();
    if (mode === "revoke") await sessions.revokeSession(identity.session.id);
    if (mode === "expire") await database.authSession.update({ where: { id: identity.session.id }, data: {
      authenticatedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000), createdAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      expiresAt: new Date(Date.now() - 60_000) } });
    if (mode === "rotate") await owners.rotateOwnerAccessCode("synthetic rotated lifecycle code");
    await expect(store.markLifecycleDispatched(identity.binding, identity.operation.id)).rejects.toMatchObject({ status: 401 });
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation" WHERE "status" = 'DISPATCHED'`).toHaveLength(0);
  });
  it("preserves an uncertain create reservation and refuses automatic redispatch", async () => {
    const identity = await reserved();
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    await store.failLifecycleOperation(identity.operation.id, true);
    expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "UNKNOWN", attempts: 1 });
    await expect(secondStore.markLifecycleDispatched(identity.binding, identity.operation.id)).rejects.toBeDefined();
    expect(await database.project.findUnique({ where: { id: identity.scope.projectId } })).toBeNull();
  });
  it("rejects replacing an existing registered sandbox through completion evidence", async () => {
    const identity = await reserved("start");
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    const before = await database.workspace.findUniqueOrThrow({ where: { id: identity.scope.workspaceRecordId } });
    await expect(store.completeLifecycleOperation(identity.binding, identity.operation.id, { id: SANDBOX_B, state: "started",
      repositoryKey: REPOSITORY_A, branch: "main", reservationId: identity.operation.id, projectId: PROJECT_A, isolationVerified: true })).rejects.toBeDefined();
    expect(await database.workspace.findUnique({ where: { id: before.id } })).toEqual(before);
  });
  it("registers a verified new sandbox atomically while preserving historical projects and workspaces", async () => {
    const historical = await database.project.findMany({ include: { workspaces: true }, orderBy: { id: "asc" } });
    const identity = await reserved();
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    const providerId = `registered-${suffix}`;
    await store.recordLifecycleResource(identity.binding, identity.operation.id, providerId);
    const operation = await store.completeLifecycleOperation(identity.binding, identity.operation.id, { id: providerId, state: "started",
      repositoryKey: null, branch: null, reservationId: identity.operation.id, projectId: identity.scope.projectId, isolationVerified: true });
    expect(operation.status).toBe("SUCCEEDED");
    const registered = await database.project.findUniqueOrThrow({ where: { id: identity.scope.projectId }, include: { workspaces: true } });
    expect(registered.workspaces).toHaveLength(1);
    expect(registered.workspaces[0]).toMatchObject({ id: identity.scope.workspaceRecordId, providerWorkspaceId: providerId, projectId: identity.scope.projectId });
    expect(await database.project.findMany({ where: { id: { in: [PROJECT_A, PROJECT_B] } }, include: { workspaces: true }, orderBy: { id: "asc" } })).toEqual(historical);
  });
  it.each([
    ["create", false], ["create", undefined], ["start", false], ["start", undefined],
  ] as const)("storage denies %s completion with isolation evidence %j", async (action, isolationVerified) => {
    const identity = await reserved(action);
    const historical = await database.workspace.findMany({ orderBy: { id: "asc" } });
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    const providerId = action === "create" ? `unverified-${identity.operation.id}` : SANDBOX_A;
    await expect(store.completeLifecycleOperation(identity.binding, identity.operation.id, {
      id: providerId, state: "started", repositoryKey: identity.scope.repositoryKey, branch: identity.scope.branch,
      reservationId: identity.operation.id, projectId: identity.scope.projectId, isolationVerified: isolationVerified as boolean,
    })).rejects.toMatchObject({ status: 409 });
    expect(await database.workspace.findMany({ orderBy: { id: "asc" } })).toEqual(historical);
    expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "DISPATCHED" });
    if (action === "create") expect(await database.project.findUnique({ where: { id: identity.scope.projectId } })).toBeNull();
  });
  it("storage denies uncertain start reconciliation without verified isolation", async () => {
    const identity = await reserved("start");
    const before = await database.workspace.findUniqueOrThrow({ where: { projectId: PROJECT_A } });
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    await store.failLifecycleOperation(identity.operation.id, true);
    await store.claimLifecycleReconciliation(identity.binding, identity.operation.id);
    await expect(store.reconcileLifecycleOperation(identity.binding, identity.operation.id, {
      id: SANDBOX_A, state: "started", repositoryKey: REPOSITORY_A, branch: "main", reservationId: identity.operation.id,
      projectId: PROJECT_A, isolationVerified: false,
    })).rejects.toMatchObject({ status: 409 });
    expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "UNKNOWN" });
    expect(await database.workspace.findUnique({ where: { id: before.id } })).toEqual(before);
  });
  it("storage can confirm shutdown of the exact historical sandbox with unverified startup isolation", async () => {
    const identity = await reserved("stop");
    await database.workspace.update({ where: { projectId: PROJECT_A }, data: { state: "ready" } });
    const before = await database.workspace.findUniqueOrThrow({ where: { projectId: PROJECT_A } });
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    expect(await store.completeLifecycleOperation(identity.binding, identity.operation.id, {
      id: SANDBOX_A, state: "stopped", repositoryKey: REPOSITORY_A, branch: "main", reservationId: identity.operation.id,
      projectId: PROJECT_A, isolationVerified: false,
    })).toMatchObject({ status: "SUCCEEDED", action: "stop" });
    const after = await database.workspace.findUniqueOrThrow({ where: { id: before.id } });
    expect({ ...after, state: before.state, updatedAt: before.updatedAt }).toEqual(before);
    expect(after.state).toBe("stopped");
  });
  it("rejects provider resource reuse belonging to another project", async () => {
    const identity = await reserved();
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    await expect(store.recordLifecycleResource(identity.binding, identity.operation.id, SANDBOX_B)).rejects.toBeDefined();
    expect(await database.project.findUnique({ where: { id: identity.scope.projectId } })).toBeNull();
  });
  it("reconciles only a verified matching uncertain reservation without issuing a second create", async () => {
    const identity = await reserved();
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    const providerId = `reconciled-${suffix}`;
    await store.recordLifecycleResource(identity.binding, identity.operation.id, providerId);
    await store.failLifecycleOperation(identity.operation.id, true);
    await secondStore.claimLifecycleReconciliation(identity.binding, identity.operation.id);
    const outcome = await secondStore.reconcileLifecycleOperation(identity.binding, identity.operation.id,
      { id: providerId, state: "started", repositoryKey: null, branch: null, reservationId: identity.operation.id, projectId: identity.scope.projectId, isolationVerified: true });
    expect(outcome).toMatchObject({ status: "SUCCEEDED", providerResourceId: providerId, attempts: 1 });
    expect(outcome.reconciledAt).toBeInstanceOf(Date);
    expect(await database.workspace.count({ where: { projectId: identity.scope.projectId } })).toBe(1);
  });
  it("does not clear UNKNOWN or silently register a different reconciliation resource", async () => {
    const identity = await reserved();
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    await store.recordLifecycleResource(identity.binding, identity.operation.id, `observed-${suffix}`);
    await store.failLifecycleOperation(identity.operation.id, true);
    await expect(store.reconcileLifecycleOperation(identity.binding, identity.operation.id,
      { id: `different-${suffix}`, state: "started", repositoryKey: null, branch: null,
        reservationId: identity.operation.id, projectId: identity.scope.projectId, isolationVerified: true })).rejects.toBeDefined();
    expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "UNKNOWN" });
  });
  it("runs the authenticated approval, durable reservation, provider verification and registration path", async () => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    const result = await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider, identity.approval.approvalId);
    expect(result).toMatchObject({ ok: true, action: "create", status: "SUCCEEDED", projectId: identity.approval.scope.projectId });
    expect(provider.create).toHaveBeenCalledExactlyOnceWith({ operationId: result.operationId,
      projectId: result.projectId, workspaceRecordId: identity.approval.scope.workspaceRecordId }, expect.any(AbortSignal), expect.any(Function));
    const registered = await database.project.findUniqueOrThrow({ where: { id: result.projectId }, include: { workspaces: true } });
    expect(registered.workspaces[0]).toMatchObject({ id: identity.approval.scope.workspaceRecordId,
      providerWorkspaceId: `synthetic-${result.operationId}` });
    for (const secret of [identity.token, identity.session.id, ownerFixture.accessCodeHash]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(vi.mocked(provider.create).mock.calls)).not.toContain(secret);
    }
    const retried = await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider, identity.approval.approvalId);
    expect(retried).toEqual(result); expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it.each([
    undefined, null, { userId: "owner", role: "owner", provider: "private-session", authenticated: true },
    { userId: "local-dev", role: "owner", provider: "disabled", authenticated: false },
    { userId: "owner", role: "owner", provider: "dev-token", authenticated: true },
  ])("rejects missing or fabricated owner provenance before lifecycle work: %j", forged => {
    const provider = controlledProvider();
    return expect(service.executeWorkspaceLifecycleWithProvider(forged as AuthSession, createRequest(), provider)).rejects.toMatchObject({ status: 401 })
      .then(() => expect(provider.create).not.toHaveBeenCalled());
  });
  it("rejects a copied genuine owner object without transferring its private proof", async () => {
    const identity = await owner(), provider = controlledProvider();
    await expect(service.executeWorkspaceLifecycleWithProvider({ ...identity.authSession }, createRequest(), provider)).rejects.toMatchObject({ status: 401 });
    expect(provider.create).not.toHaveBeenCalled();
  });
  it.each(["revoke", "expire", "rotate"])("denies service dispatch after approved session %s", async mode => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    if (mode === "revoke") await sessions.revokeSession(identity.session.id);
    if (mode === "expire") await database.authSession.update({ where: { id: identity.session.id }, data: {
      authenticatedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000), createdAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      expiresAt: new Date(Date.now() - 60_000) } });
    if (mode === "rotate") await owners.rotateOwnerAccessCode("synthetic service rotated code");
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 401 });
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("never accepts client session, workspace, approval or repository scope claims", async () => {
    const identity = await owner(), provider = controlledProvider();
    for (const forged of [{ sessionId: identity.session.id }, { providerWorkspaceId: SANDBOX_B }, { ownerId: "owner" },
      { approvalId: randomUUID() }, { repositoryUrl: "https://github.com/unrelated/repo.git" }]) {
      await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, { ...createRequest(), ...forged }, provider)).rejects.toMatchObject({ status: 403 });
    }
    expect(provider.create).not.toHaveBeenCalled();
  });
  it.each(["balanced", "strict"] as const)("requires durable exact operation approval under %s policy", async profile => {
    policy.setPolicyProfile(profile);
    const identity = await owner(), provider = controlledProvider();
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, createRequest(), provider)).rejects.toBeDefined();
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("autonomous policy permits the isolated core but cannot remove the production release gate", async () => {
    policy.setPolicyProfile("autonomous");
    const identity = await owner(), provider = controlledProvider(), request = createRequest();
    expect(await service.executeWorkspaceLifecycleWithProvider(identity.authSession, request, provider)).toMatchObject({ status: "SUCCEEDED" });
    await expect(service.executeWorkspaceLifecycle(identity.authSession, createRequest())).rejects.toMatchObject({ status: 503 });
  });
  it("unknown projects cannot select a sandbox or initiate start", async () => {
    const identity = await owner(), provider = controlledProvider();
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession,
      { action: "start", projectId: "unknown-project", idempotencyKey: randomUUID() }, provider)).rejects.toMatchObject({ status: 404 });
    expect(provider.inspect).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled();
  });
  it("project remapping invalidates prior approval without touching either resource", async () => {
    const identity = await approvedServiceRequest(startRequest()), provider = controlledProvider();
    await database.workspace.update({ where: { id: identity.approval.scope.workspaceRecordId }, data: { providerWorkspaceId: `remapped-${suffix}` } });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toBeDefined();
    expect(provider.inspect).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled();
  });
  it("read-only state inspection never starts, replaces or registers a stopped workspace", async () => {
    const identity = await owner(), provider = controlledProvider();
    const before = await database.workspace.findMany({ orderBy: { id: "asc" } });
    expect(await service.inspectWorkspaceLifecycleWithProvider(identity.authSession, PROJECT_A, provider)).toMatchObject({ projectId: PROJECT_A, state: "stopped" });
    expect(provider.inspect).toHaveBeenCalledExactlyOnceWith(SANDBOX_A, expect.any(AbortSignal));
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
    expect(await database.workspace.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(0);
  });
  it.each(["start", "stop"] as const)("dispatches explicit approved %s against only the registered sandbox", async action => {
    const identity = await approvedServiceRequest({ action, projectId: PROJECT_A, idempotencyKey: randomUUID() }), provider = controlledProvider();
    const before = await database.workspace.findUniqueOrThrow({ where: { id: identity.approval.scope.workspaceRecordId } });
    expect(await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).toMatchObject({ status: "SUCCEEDED", action, projectId: PROJECT_A });
    expect(provider[action]).toHaveBeenCalledExactlyOnceWith(SANDBOX_A, expect.any(AbortSignal), expect.any(Function));
    expect(provider.create).not.toHaveBeenCalled();
    const after = await database.workspace.findUniqueOrThrow({ where: { id: before.id } });
    expect({ ...after, state: before.state, updatedAt: before.updatedAt }).toEqual(before);
    expect(after.state).toBe(action === "start" ? "ready" : "stopped");
  });
  it.each(["stopped", "started"] as const)("rejects an insecure %s sandbox before any start mutation", async state => {
    const identity = await approvedServiceRequest(startRequest()), provider = controlledProvider();
    const before = await database.workspace.findMany({ orderBy: { id: "asc" } });
    vi.mocked(provider.inspect).mockResolvedValue({ ...resource(SANDBOX_A, state), isolationVerified: false });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    expect(provider.start).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
    expect(await database.workspace.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(await database.workspaceLifecycleOperation.findMany()).toMatchObject([{ status: "FAILED", attempts: 0 }]);
  });
  it.each([undefined, null, 1, "true"])("does not accept malformed adapter isolation evidence %j before starting", async isolationVerified => {
    const identity = await approvedServiceRequest(startRequest()), provider = controlledProvider();
    vi.mocked(provider.inspect).mockResolvedValue({ ...resource(SANDBOX_A, "stopped"), isolationVerified } as unknown as LifecycleResource);
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    expect(provider.start).not.toHaveBeenCalled();
    expect(await database.workspace.findUnique({ where: { projectId: PROJECT_A } })).toMatchObject({ state: "stopped", providerWorkspaceId: SANDBOX_A });
  });
  it.each([false, undefined, "true"])("withholds readiness when start completion isolation is %j", async isolationVerified => {
    const identity = await approvedServiceRequest(startRequest()), provider = controlledProvider();
    const before = await database.workspace.findMany({ orderBy: { id: "asc" } });
    vi.mocked(provider.start).mockImplementation(async (id, _signal, beforeDispatch) => {
      await beforeDispatch!(); return { ...resource(id), isolationVerified } as unknown as LifecycleResource;
    });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    expect(provider.start).toHaveBeenCalledOnce(); expect(provider.create).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
    expect(await database.workspace.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    const [operation] = await database.workspaceLifecycleOperation.findMany();
    expect(operation).toMatchObject({ status: "UNKNOWN", attempts: 1 });
    expect(await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).toMatchObject({ ok: false, status: "UNKNOWN", operationId: operation.id });
    expect(provider.start).toHaveBeenCalledOnce();
  });
  it.each(["session", "registration"])("rechecks %s after secure startup preflight and before mutation", async changed => {
    const identity = await approvedServiceRequest(startRequest()), provider = controlledProvider();
    vi.mocked(provider.inspect).mockImplementation(async id => {
      if (changed === "session") await sessions.revokeSession(identity.session.id);
      else await database.workspace.update({ where: { projectId: PROJECT_A }, data: { providerWorkspaceId: "externally-remapped-fixture" } });
      return resource(id, "stopped");
    });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toBeDefined();
    expect(provider.start).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
    expect(await database.workspace.findUnique({ where: { projectId: PROJECT_A } })).toMatchObject({ state: "stopped" });
    expect(await database.workspaceLifecycleOperation.findMany()).toMatchObject([{ status: "FAILED", attempts: 0 }]);
  });
  it("stops an approved historical sandbox without requiring its isolation to qualify for startup", async () => {
    const identity = await approvedServiceRequest({ action: "stop", projectId: PROJECT_A, idempotencyKey: randomUUID() });
    const provider = controlledProvider();
    await database.workspace.update({ where: { projectId: PROJECT_A }, data: { state: "ready" } });
    const before = await database.workspace.findUniqueOrThrow({ where: { projectId: PROJECT_A } });
    vi.mocked(provider.inspect).mockResolvedValue({ ...resource(SANDBOX_A), isolationVerified: false });
    vi.mocked(provider.stop).mockImplementation(async (id, _signal, beforeDispatch) => {
      await beforeDispatch!(); return { ...resource(id, "stopped"), isolationVerified: false };
    });
    expect(await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).toMatchObject({ status: "SUCCEEDED", action: "stop", projectId: PROJECT_A });
    const after = await database.workspace.findUniqueOrThrow({ where: { projectId: PROJECT_A } });
    expect({ ...after, state: before.state, updatedAt: before.updatedAt }).toEqual(before);
    expect(after.state).toBe("stopped"); expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.start).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
  });
  it("refuses a provider lookup returning another sandbox before start mutation", async () => {
    const identity = await approvedServiceRequest(startRequest()), provider = controlledProvider();
    vi.mocked(provider.inspect).mockResolvedValue(resource(SANDBOX_B));
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    expect(provider.start).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
    const rows = await database.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "WorkspaceLifecycleOperation"`;
    expect(rows).toEqual([{ status: "FAILED" }]);
  });
  it("keeps approved cloning blocked without exposing credentials or creating a resource", async () => {
    const identity = await approvedClone(), provider = controlledProvider();
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    expect(provider.create).not.toHaveBeenCalled();
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(0);
  });
  it("does not clone an already registered repository using a different project name", async () => {
    const identity = await owner();
    await expect(service.prepareWorkspaceLifecycleWithRepository(identity.authSession, { action: "clone", projectName: "Replacement attempt",
      repositoryUrl: `https://github.com/${REPOSITORY_A}.git`, branch: "main", idempotencyKey: randomUUID() }, repositoryTransport())).rejects.toMatchObject({ status: 409 });
    expect(await database.workspace.count()).toBe(2);
  });
  it("keeps public clone approval and execution blocked before credential transport", async () => {
    const identity = await owner(), request = { action: "clone", repositoryUrl: "https://github.com/synthetic-owner/new-repository",
      branch: "main", idempotencyKey: randomUUID() };
    await expect(service.prepareWorkspaceLifecycle(identity.authSession, request)).rejects.toMatchObject({ status: 503 });
    await expect(service.executeWorkspaceLifecycle(identity.authSession, request)).rejects.toMatchObject({ status: 503 });
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleApproval"`).toHaveLength(0);
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(0);
  });
  it("records the exact new sandbox before transfer and registers only independently verified history", async () => {
    const identity = await approvedClone(), provider = controlledProvider();
    const historical = await database.project.findMany({ include: { workspaces: true }, orderBy: { id: "asc" } });
    const original = vi.mocked(identity.transport.initialize).getMockImplementation()!;
    vi.mocked(identity.transport.initialize).mockImplementation(async (...args) => {
      const [scope, operationId, sandbox] = args;
      expect(await store.readLifecycleOperation(identity.binding, operationId)).toMatchObject({ status: "DISPATCHED", providerResourceId: sandbox });
      expect(await database.project.findUnique({ where: { id: scope.projectId } })).toBeNull();
      return original(...args);
    });
    const result = await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId, undefined, identity.transport);
    expect(result).toMatchObject({ ok: true, status: "SUCCEEDED", action: "clone" });
    expect(identity.approval.preview.expectedHead).toBe("a".repeat(40));
    expect(identity.transport.prepare).toHaveBeenCalledOnce();
    expect(identity.transport.initialize).toHaveBeenCalledOnce();
    expect(identity.transport.inspect).toHaveBeenCalledOnce();
    const workspace = await database.workspace.findUniqueOrThrow({ where: { projectId: result.projectId } });
    expect(workspace).toMatchObject({ state: "ready", providerWorkspaceId: `synthetic-${result.operationId}`,
      repositoryUrl: "https://github.com/synthetic-owner/new-repository.git", branch: "main" });
    expect(await database.project.findMany({ where: { id: { in: [PROJECT_A, PROJECT_B] } }, include: { workspaces: true }, orderBy: { id: "asc" } })).toEqual(historical);
  });
  it("validates the complete source graph before creating a sandbox", async () => {
    const identity = await approvedClone(), provider = controlledProvider();
    vi.mocked(identity.transport.prepare).mockRejectedValue(new Error("synthetic-token should not escape"));
    const error = await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId, undefined, identity.transport).catch(error => error);
    expect(error).toMatchObject({ status: 503 }); expect(String(error)).not.toContain("synthetic-token");
    expect(provider.create).not.toHaveBeenCalled(); expect(identity.transport.initialize).not.toHaveBeenCalled();
    expect(await database.$queryRaw`SELECT "status", "attempts" FROM "WorkspaceLifecycleOperation"`).toEqual([{ status: "FAILED", attempts: 0 }]);
  });
  it("rejects stale approved remote HEAD instead of silently substituting a new clone", async () => {
    const identity = await approvedClone(), provider = controlledProvider();
    vi.mocked(identity.transport.resolveHead).mockResolvedValue("b".repeat(40));
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId, undefined, identity.transport)).rejects.toMatchObject({ status: 409 });
    expect(provider.create).not.toHaveBeenCalled(); expect(identity.transport.prepare).not.toHaveBeenCalled();
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(0);
  });
  it("does not reinterpret a legacy clone approval without verified HEAD as initialization authority", async () => {
    const identity = await approvedClone();
    await database.$executeRaw`UPDATE "WorkspaceLifecycleApproval" SET "scope" = "scope" - 'initialization'
      WHERE "id" = ${identity.approval.approvalId}::uuid`;
    const other = await store.createLifecycleApproval(identity.binding, await registeredScope());
    expect((await store.listLifecycleApprovals(identity.binding)).map(row => row.id)).toEqual([other.id]);
    await expect(secondStore.reserveLifecycleOperation(identity.binding, identity.approval.scope, {
      idempotencyKey: identity.request.idempotencyKey, approvalId: identity.approval.approvalId, requiresApproval: true,
    })).rejects.toMatchObject({ status: 409 });
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(0);
  });
  it("coordinates clone approval consumption and one dispatch across independent PostgreSQL pools", async () => {
    const identity = await approvedClone();
    const options = { idempotencyKey: identity.request.idempotencyKey, approvalId: identity.approval.approvalId, requiresApproval: true };
    const reservations = await Promise.all([store, secondStore].map(instance => instance.reserveLifecycleOperation(identity.binding, identity.approval.scope, options)));
    expect(new Set(reservations.map(result => result.operation.id)).size).toBe(1);
    expect(reservations.filter(result => result.reused)).toHaveLength(1);
    const operationId = reservations[0].operation.id;
    const dispatches = await Promise.allSettled([store, secondStore].map(instance => instance.markLifecycleDispatched(identity.binding, operationId)));
    expect(dispatches.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(dispatches.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it.each(["expectedHead", "initialization", "providerWorkspaceId", "projectId"])("rejects client-supplied clone authority: %s", field => {
    expect(() => catalogue.parseWorkspaceLifecycleRequest({ action: "clone", repositoryUrl: "https://github.com/synthetic-owner/new-repository",
      branch: "main", idempotencyKey: randomUUID(), [field]: "forged" })).toThrow();
  });
  it.each([
    { status: "incomplete" }, { head: "b".repeat(40) }, { historyVerified: false },
    { branch: "another-branch" }, { repositoryKey: REPOSITORY_B },
  ])("retains the sandbox without registration on unverified clone result: %j", changed => {
    return (async () => {
      const identity = await approvedClone(), provider = controlledProvider();
      vi.mocked(identity.transport.inspect).mockResolvedValue({ status: "complete", repositoryKey: identity.approval.scope.repositoryKey!,
        branch: "main", head: "a".repeat(40), historyVerified: true, ...changed } as Awaited<ReturnType<RepositoryInitializationTransport["inspect"]>>);
      await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
        identity.approval.approvalId, undefined, identity.transport)).rejects.toMatchObject({ status: 409 });
      const [operation] = await database.$queryRaw<Array<{ id: string; status: string; providerResourceId: string }>>`
        SELECT "id", "status", "providerResourceId" FROM "WorkspaceLifecycleOperation"`;
      expect(operation).toMatchObject({ status: "UNKNOWN", providerResourceId: `synthetic-${operation.id}` });
      expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
      expect(provider.create).toHaveBeenCalledOnce();
    })();
  });
  it.each(["revoke", "expire", "rotate"])("prevents clone registration when authorization changes during transfer: %s", async mode => {
    const identity = await approvedClone(), provider = controlledProvider();
    vi.mocked(identity.transport.initialize).mockImplementation(async (scope, _id, _sandbox, revalidate) => {
      if (mode === "rotate") await owners.rotateOwnerAccessCode("synthetic rotated fixture");
      else await database.authSession.update({ where: { id: identity.session.id }, data: mode === "revoke" ? { revokedAt: new Date() } : {
        authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
      } });
      await revalidate();
      return { status: "complete", repositoryKey: scope.repositoryKey!, branch: scope.branch!, head: scope.initialization!.expectedHead, historyVerified: true };
    });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId, undefined, identity.transport)).rejects.toMatchObject({ status: 401 });
    expect(identity.transport.inspect).not.toHaveBeenCalled();
    expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
    expect(await database.$queryRaw`SELECT "status" FROM "WorkspaceLifecycleOperation"`).toEqual([{ status: "UNKNOWN" }]);
  });
  it("does not dispatch a duplicate clone when concurrent requests share the approved reservation", async () => {
    const identity = await approvedClone(), provider = controlledProvider();
    const results = await Promise.all([1, 2].map(() => service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId, undefined, identity.transport)));
    expect(new Set(results.map(result => result.operationId)).size).toBe(1);
    expect(provider.create).toHaveBeenCalledOnce(); expect(identity.transport.initialize).toHaveBeenCalledOnce();
    expect(await database.workspace.count({ where: { projectId: identity.approval.scope.projectId } })).toBe(1);
  });
  it.each(["absent", "incomplete", "mismatched", "complete"] as const)("reconciles an uncertain clone only from independent evidence: %s", async status => {
    const identity = await approvedClone(), provider = controlledProvider();
    vi.mocked(identity.transport.initialize).mockRejectedValue(new Error("transfer disconnected"));
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId, undefined, identity.transport)).rejects.toMatchObject({ status: 503 });
    const [operation] = await database.$queryRaw<Array<{ id: string; providerResourceId: string }>>`SELECT "id", "providerResourceId" FROM "WorkspaceLifecycleOperation"`;
    vi.mocked(identity.transport.inspect).mockResolvedValue({ status, repositoryKey: identity.approval.scope.repositoryKey!, branch: "main",
      head: status === "complete" ? "a".repeat(40) : null, historyVerified: status === "complete" });
    const result = await service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, operation.id, provider, undefined, identity.transport);
    expect(result).toMatchObject(status === "complete" ? { status: "SUCCEEDED", ok: true } : { status: "UNKNOWN", ok: false, repositoryState: status });
    expect(await database.workspace.count({ where: { projectId: identity.approval.scope.projectId } })).toBe(status === "complete" ? 1 : 0);
    expect(provider.create).toHaveBeenCalledOnce(); expect(identity.transport.initialize).toHaveBeenCalledOnce();
    expect(identity.transport.inspect).toHaveBeenCalledOnce(); expect(provider.findCreated).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
  });
  it("does not inspect a substituted sandbox during uncertain clone reconciliation", async () => {
    const identity = await approvedClone(), provider = controlledProvider();
    vi.mocked(identity.transport.initialize).mockRejectedValue(new Error("interrupted"));
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId, undefined, identity.transport)).rejects.toBeDefined();
    const [operation] = await database.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "WorkspaceLifecycleOperation"`;
    vi.mocked(provider.inspect).mockResolvedValue(resource("unrelated-resource"));
    await expect(service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, operation.id, provider, undefined, identity.transport)).rejects.toBeDefined();
    expect(identity.transport.inspect).not.toHaveBeenCalled();
    expect(await database.workspace.count()).toBe(2);
  });
  it("storage independently requires exact clone history evidence before registration", async () => {
    const identity = await approvedClone();
    const { operation } = await store.reserveLifecycleOperation(identity.binding, identity.approval.scope,
      { idempotencyKey: identity.request.idempotencyKey, approvalId: identity.approval.approvalId, requiresApproval: true });
    await store.markLifecycleDispatched(identity.binding, operation.id);
    const providerId = `synthetic-${operation.id}`;
    await store.recordLifecycleResource(identity.binding, operation.id, providerId);
    const evidence = { id: providerId, state: "started" as const, isolationVerified: true, repositoryKey: identity.approval.scope.repositoryKey,
      branch: "main", reservationId: operation.id, projectId: operation.projectId };
    await expect(store.completeLifecycleOperation(identity.binding, operation.id, evidence)).rejects.toMatchObject({ status: 409 });
    await expect(store.completeLifecycleOperation(identity.binding, operation.id, { ...evidence, repositoryInitialization: {
      status: "complete", repositoryKey: identity.approval.scope.repositoryKey!, branch: "main", head: "b".repeat(40), historyVerified: true,
    } })).rejects.toMatchObject({ status: 409 });
    expect(await database.project.findUnique({ where: { id: operation.projectId } })).toBeNull();
  });
  it("sanitizes provider failure after create dispatch and retains UNKNOWN without retry", async () => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    vi.mocked(provider.create).mockRejectedValue(new Error("provider-token=synthetic-secret repository-private-content"));
    const error = await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId).catch(error => error);
    expect(error).toMatchObject({ status: 503 }); expect(String(error)).not.toMatch(/synthetic-secret|repository-private-content/);
    const rows = await database.$queryRaw<Array<{ id: string; status: string }>>`SELECT "id", "status" FROM "WorkspaceLifecycleOperation"`;
    expect(rows).toHaveLength(1); expect(rows[0].status).toBe("UNKNOWN");
    const retried = await service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider, identity.approval.approvalId);
    expect(retried).toMatchObject({ ok: false, status: "UNKNOWN", operationId: rows[0].id });
    expect(provider.create).toHaveBeenCalledOnce();
    expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
  });
  it("withholds registration when the owner revokes the session during provider creation", async () => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    const originalCreate = vi.mocked(provider.create).getMockImplementation()!;
    vi.mocked(provider.create).mockImplementation(async (input, signal, beforeDispatch) => {
      const value = await originalCreate(input, signal, beforeDispatch);
      await sessions.revokeSession(identity.session.id); return value;
    });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 401 });
    expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation" WHERE "status" = 'UNKNOWN'`).toHaveLength(1);
  });
  it("does not register a provider resource with mismatched reservation labels", async () => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    vi.mocked(provider.create).mockResolvedValue({ ...resource("foreign-resource"), labels: { "cr8or-owner": "owner" } });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation" WHERE "status" = 'UNKNOWN'`).toHaveLength(1);
  });
  it.each([false, undefined, "true"])("does not register a new resource with isolation evidence %j despite exact reservation labels", async isolationVerified => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    const historical = await database.project.findMany({ include: { workspaces: true }, orderBy: { id: "asc" } });
    const originalCreate = vi.mocked(provider.create).getMockImplementation()!;
    vi.mocked(provider.create).mockImplementation(async (input, signal, beforeDispatch) => ({
      ...await originalCreate(input, signal, beforeDispatch), isolationVerified,
    } as unknown as LifecycleResource));
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
    expect(await database.project.findMany({ include: { workspaces: true }, orderBy: { id: "asc" } })).toEqual(historical);
    expect(await database.workspaceLifecycleOperation.findMany()).toMatchObject([{ status: "UNKNOWN", attempts: 1 }]);
    expect(provider.create).toHaveBeenCalledOnce(); expect(provider.start).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
  });
  it("records an uncertain outcome after an actual PostgreSQL registration failure", async () => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    // Generated hexadecimal identity only, in this disposable schema. Force the
    // final INSERT to fail while all session and operation queries remain live.
    expect(identity.approval.scope.projectId).toMatch(/^cloud-[a-f0-9]{32}$/);
    await database.$executeRawUnsafe(`ALTER TABLE "Project" ADD CONSTRAINT "fixture_registration_failure" CHECK ("id" <> '${identity.approval.scope.projectId}')`);
    try {
      await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
        identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    } finally {
      await database.$executeRawUnsafe('ALTER TABLE "Project" DROP CONSTRAINT "fixture_registration_failure"');
    }
    expect(provider.create).toHaveBeenCalledOnce();
    const [operation] = await database.$queryRaw<Array<{ id: string; status: string; providerResourceId: string | null }>>`
      SELECT "id", "status", "providerResourceId" FROM "WorkspaceLifecycleOperation"`;
    expect(operation).toMatchObject({ status: "UNKNOWN", providerResourceId: `synthetic-${operation.id}` });
    expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
    expect(await service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, operation.id, provider)).toMatchObject({ status: "SUCCEEDED" });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it("reconciles provider timeout after creation using exact evidence without replacing resources", async () => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    const original = vi.mocked(provider.create).getMockImplementation()!;
    vi.mocked(provider.create).mockImplementation(async (input, signal, beforeDispatch) => {
      await original(input, signal, beforeDispatch); throw new providerHelpers.LifecycleProviderError("TIMED_OUT", true);
    });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    const [operation] = await database.$queryRaw<Array<{ id: string; status: string }>>`SELECT "id", "status" FROM "WorkspaceLifecycleOperation"`;
    expect(operation.status).toBe("UNKNOWN");
    expect(await service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, operation.id, provider)).toMatchObject({ status: "SUCCEEDED" });
    expect(provider.findCreated).toHaveBeenCalledOnce(); expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.start).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
  });
  it.each(["none", "multiple", "wrong-label", "wrong-isolation"])("retains UNKNOWN on unverifiable reconciliation evidence: %s", async kind => {
    const identity = await reserved();
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    await store.failLifecycleOperation(identity.operation.id, true);
    const provider = controlledProvider();
    const candidate = { ...resource("candidate-resource"), labels: providerHelpers.lifecycleCreationLabels({ operationId: identity.operation.id,
      projectId: identity.scope.projectId, workspaceRecordId: identity.scope.workspaceRecordId }) };
    vi.mocked(provider.findCreated).mockResolvedValue(kind === "none" ? [] : kind === "multiple" ? [candidate, { ...candidate, id: "second-candidate" }]
      : kind === "wrong-label" ? [{ ...candidate, labels: { ...candidate.labels, "cr8or-project": PROJECT_B } }]
      : [{ ...candidate, isolationVerified: false }]);
    await expect(service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, identity.operation.id, provider)).rejects.toBeDefined();
    expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "UNKNOWN" });
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
    expect(await database.project.findUnique({ where: { id: identity.scope.projectId } })).toBeNull();
  });
  it.each([false, undefined, "true"])("retains an uncertain start when reconciliation isolation is %j", async isolationVerified => {
    const identity = await reserved("start"), provider = controlledProvider();
    const before = await database.workspace.findMany({ orderBy: { id: "asc" } });
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    await store.failLifecycleOperation(identity.operation.id, true);
    vi.mocked(provider.inspect).mockResolvedValue({ ...resource(SANDBOX_A), isolationVerified } as unknown as LifecycleResource);
    await expect(service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, identity.operation.id, provider)).rejects.toBeDefined();
    expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "UNKNOWN", attempts: 1 });
    expect(await database.workspace.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
    // A separately requested read-only reconciliation can confirm later verified
    // evidence after the existing cooldown; no mutation is retried or repaired.
    await database.$executeRaw`UPDATE "WorkspaceLifecycleOperation" SET "lastReconciliationAt" = NOW() - INTERVAL '61 seconds'
      WHERE "id" = ${identity.operation.id}::uuid`;
    vi.mocked(provider.inspect).mockResolvedValue(resource(SANDBOX_A));
    expect(await service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, identity.operation.id, provider))
      .toMatchObject({ status: "SUCCEEDED", action: "start", projectId: PROJECT_A });
    expect(await database.workspace.findUnique({ where: { id: identity.scope.workspaceRecordId } }))
      .toMatchObject({ projectId: PROJECT_A, providerWorkspaceId: SANDBOX_A, state: "ready" });
    expect(provider.inspect).toHaveBeenCalledTimes(2); expect(provider.start).not.toHaveBeenCalled();
  });
  it.each(["started", "stopped"] as const)("reconciles an unsafe historical stop only when the exact resource is stopped: %s", async state => {
    const identity = await reserved("stop"), provider = controlledProvider();
    await database.workspace.update({ where: { projectId: PROJECT_A }, data: { state: "ready" } });
    const before = await database.workspace.findUniqueOrThrow({ where: { projectId: PROJECT_A } });
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    await store.failLifecycleOperation(identity.operation.id, true);
    vi.mocked(provider.inspect).mockResolvedValue({ ...resource(SANDBOX_A, state), isolationVerified: false });
    const reconcile = service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, identity.operation.id, provider);
    if (state === "started") {
      await expect(reconcile).rejects.toBeDefined();
      expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "UNKNOWN" });
      expect(await database.workspace.findUnique({ where: { id: before.id } })).toEqual(before);
    } else {
      await expect(reconcile).resolves.toMatchObject({ status: "SUCCEEDED", action: "stop" });
      const after = await database.workspace.findUniqueOrThrow({ where: { id: before.id } });
      expect({ ...after, state: before.state, updatedAt: before.updatedAt }).toEqual(before);
      expect(after.state).toBe("stopped");
    }
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled(); expect(provider.stop).not.toHaveBeenCalled();
  });
  it("cancels abandoned pre-dispatch reservations without a provider call and never redispatches them", async () => {
    const identity = await reserved(), provider = controlledProvider();
    await database.$executeRaw`UPDATE "WorkspaceLifecycleOperation" SET "createdAt" = NOW() - INTERVAL '2 minutes'
      WHERE "id" = ${identity.operation.id}::uuid`;
    expect(await service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, identity.operation.id, provider)).toMatchObject({ status: "CANCELLED" });
    await expect(store.markLifecycleDispatched(identity.binding, identity.operation.id)).rejects.toBeDefined();
    expect(provider.findCreated).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
  });
  it("request cancellation during creation prevents registration and leaves dispatched work uncertain", async () => {
    const identity = await approvedServiceRequest(), provider = controlledProvider(), controller = new AbortController();
    const original = vi.mocked(provider.create).getMockImplementation()!;
    vi.mocked(provider.create).mockImplementation(async (input, signal, beforeDispatch) => {
      const created = await original(input, signal, beforeDispatch); controller.abort(); return created;
    });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId, controller.signal)).rejects.toMatchObject({ status: 401 });
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation" WHERE "status" = 'UNKNOWN'`).toHaveLength(1);
    expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
  });
  it("credential rotation during creation prevents new registration and reconciliation with obsolete proof", async () => {
    const identity = await approvedServiceRequest(), provider = controlledProvider();
    const original = vi.mocked(provider.create).getMockImplementation()!;
    vi.mocked(provider.create).mockImplementation(async (input, signal, beforeDispatch) => {
      const created = await original(input, signal, beforeDispatch); await owners.rotateOwnerAccessCode("synthetic rotation during transfer"); return created;
    });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toMatchObject({ status: 401 });
    const [operation] = await database.$queryRaw<Array<{ id: string; status: string }>>`SELECT "id", "status" FROM "WorkspaceLifecycleOperation"`;
    expect(operation.status).toBe("UNKNOWN");
    await expect(service.reconcileWorkspaceLifecycleWithProvider(identity.authSession, operation.id, provider)).rejects.toMatchObject({ status: 401 });
    expect(provider.findCreated).not.toHaveBeenCalled();
    expect(await database.project.findUnique({ where: { id: identity.approval.scope.projectId } })).toBeNull();
  });
  it("limits provisioning across independent application instances", async () => {
    const identity = await owner();
    const requests = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled([store, secondStore].map((instance, index) => instance.reserveLifecycleOperation(identity.binding,
      creationScope(identity.binding, requests[index]), { idempotencyKey: requests[index], requiresApproval: false })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(1);
  });
  it("bounds repeated provisioning attempts even after safe pre-dispatch failures", async () => {
    const identity = await owner();
    for (let attempt = 0; attempt < store.LIFECYCLE_MAX_CREATIONS; attempt += 1) {
      const idempotencyKey = randomUUID();
      const reservation = await store.reserveLifecycleOperation(identity.binding, creationScope(identity.binding, idempotencyKey),
        { idempotencyKey, requiresApproval: false });
      await store.failLifecycleOperation(reservation.operation.id, false);
    }
    const idempotencyKey = randomUUID();
    await expect(secondStore.reserveLifecycleOperation(identity.binding, creationScope(identity.binding, idempotencyKey),
      { idempotencyKey, requiresApproval: false })).rejects.toMatchObject({ status: 409 });
  });
  it("keeps every public lifecycle facade release-blocked for a valid approved owner", async () => {
    const identity = await approvedServiceRequest();
    await expect(service.executeWorkspaceLifecycle(identity.authSession, identity.request, identity.approval.approvalId)).rejects.toMatchObject({ status: 503 });
    await expect(service.inspectWorkspaceLifecycle(identity.authSession, PROJECT_A)).rejects.toMatchObject({ status: 503 });
    await expect(service.reconcileWorkspaceLifecycle(identity.authSession, randomUUID())).rejects.toMatchObject({ status: 503 });
    expect(await database.$queryRaw`SELECT "id" FROM "WorkspaceLifecycleOperation"`).toHaveLength(0);
  });
  it("rejects state output if the registered sandbox changes during the provider read", async () => {
    const identity = await owner(), provider = controlledProvider();
    vi.mocked(provider.inspect).mockImplementation(async id => {
      await database.workspace.update({ where: { projectId: PROJECT_A }, data: { providerWorkspaceId: "changed-during-read" } });
      return resource(id, "stopped");
    });
    await expect(service.inspectWorkspaceLifecycleWithProvider(identity.authSession, PROJECT_A, provider)).rejects.toMatchObject({ status: 409 });
    expect(provider.start).not.toHaveBeenCalled();
  });
  it.each(["session", "approval"])("rechecks %s revocation immediately before provider mutation", async kind => {
    const identity = await approvedServiceRequest(startRequest()), provider = controlledProvider();
    const mutation = vi.fn();
    vi.mocked(provider.start).mockImplementation(async (id, _signal, beforeDispatch) => {
      if (kind === "session") await sessions.revokeSession(identity.session.id);
      else await store.decideLifecycleApproval(identity.binding, identity.approval.approvalId, "revoked");
      await beforeDispatch!();
      mutation();
      return resource(id);
    });
    await expect(service.executeWorkspaceLifecycleWithProvider(identity.authSession, identity.request, provider,
      identity.approval.approvalId)).rejects.toBeDefined();
    expect(mutation).not.toHaveBeenCalled();
    expect(await database.workspace.findUnique({ where: { projectId: PROJECT_A } })).toMatchObject({ state: "stopped" });
    expect(await database.workspaceLifecycleOperation.findMany()).toMatchObject([{ status: "UNKNOWN" }]);
  });
  it("serializes reconciliation claims across instances and bounds retries after cooldown", async () => {
    const identity = await reserved();
    await store.markLifecycleDispatched(identity.binding, identity.operation.id);
    await store.failLifecycleOperation(identity.operation.id, true);
    const results = await Promise.allSettled([store, secondStore].map(instance =>
      instance.claimLifecycleReconciliation(identity.binding, identity.operation.id)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await database.$executeRaw`UPDATE "WorkspaceLifecycleOperation" SET "lastReconciliationAt" = NOW() - INTERVAL '61 seconds'
        WHERE "id" = ${identity.operation.id}::uuid`;
      expect(await store.claimLifecycleReconciliation(identity.binding, identity.operation.id)).toMatchObject({ reconciliationAttempts: attempt });
    }
    await database.$executeRaw`UPDATE "WorkspaceLifecycleOperation" SET "lastReconciliationAt" = NOW() - INTERVAL '61 seconds'
      WHERE "id" = ${identity.operation.id}::uuid`;
    await expect(secondStore.claimLifecycleReconciliation(identity.binding, identity.operation.id)).rejects.toMatchObject({ status: 409 });
    expect(await store.readLifecycleOperation(identity.binding, identity.operation.id)).toMatchObject({ status: "UNKNOWN", attempts: 1 });
  });
});
