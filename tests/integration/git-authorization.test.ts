import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient, type OwnerCredential } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/lib/security/auth";
import type { ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import type { GitOperationRequest, GitOperationScope } from "@/lib/security/git-operation-catalogue";

vi.mock("server-only", () => ({}));
// Real PostgreSQL, synthetic registry rows only. Never construct a live provider.
vi.mock("@daytona/sdk", () => ({ Daytona: class {} }));

function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "55432" || url.pathname !== "/cr8or_auth_test") {
    throw new Error("Git authorization tests require the isolated local database on port 55432.");
  }
  return url;
}
const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const suffix = randomBytes(8).toString("hex");
const schemaName = `git_authorization_${suffix}`;
const PROJECT_A = `git-project-a-${suffix}`, PROJECT_B = `git-project-b-${suffix}`;
const SANDBOX_A = `git-sandbox-a-${suffix}`, SANDBOX_B = `git-sandbox-b-${suffix}`;
// This is only a synthetic database registration for the reviewed naming map;
// this suite never connects to GitHub or creates a provider workspace.
const REPOSITORY_A = "badadeveloper001-dev/cr8or-studio", REPOSITORY_B = "synthetic-owner/repository-b";
const HEAD = "1".repeat(40), INDEX = "2".repeat(64), TARGET = "3".repeat(40);
const ORIGIN = "http://localhost:3000";
const environmentKeys = ["DATABASE_URL", "DIRECT_URL", "NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID",
  "CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY",
  "CR8OR_FEATURE_AUTH_GUARD", "CR8OR_FEATURE_AUDIT_LOG", "CR8OR_WORKSPACE_MODE", "CR8OR_POLICY_PROFILE"] as const;
const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
const previousGlobal = globalThis.prismaGlobal, previousPolicy = globalThis.__cr8orPolicyStore;
const previousApprovals = globalThis.__cr8orApprovalStore;
function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
const stage = (): GitOperationRequest => ({ operation: "stage", branch: "main", expectedHead: HEAD, expectedIndex: INDEX, paths: ["src/app.ts"] });
const push = (): GitOperationRequest => ({ operation: "push", branch: "main", expectedRemoteHead: HEAD, targetCommit: TARGET });

describe.skipIf(!testUrl)("Git approvals and coordination on isolated PostgreSQL", () => {
  let admin: PrismaClient, database: PrismaClient, secondDatabase: PrismaClient, ownerFixture: OwnerCredential;
  let auth: typeof import("@/lib/security/auth");
  let sessions: typeof import("@/lib/security/session-store");
  let owners: typeof import("@/lib/security/owner-management");
  let execution: typeof import("@/lib/security/execution-context");
  let catalogue: typeof import("@/lib/security/git-operation-catalogue");
  let approvals: typeof import("@/lib/security/git-approvals");
  let grants: typeof import("@/lib/security/git-authorization");
  let coordinator: typeof import("@/lib/workspace/private-git-operations");
  let operations: typeof import("@/lib/security/git-operation-store");
  let commands: typeof import("@/lib/security/command-operation-store");
  let policy: typeof import("@/lib/security/policy");
  let legacy: typeof import("@/lib/security/approvals");
  let secondAuth: typeof import("@/lib/security/auth");
  let secondExecution: typeof import("@/lib/security/execution-context");
  let secondApprovals: typeof import("@/lib/security/git-approvals");
  let secondOperations: typeof import("@/lib/security/git-operation-store");
  let secondCommands: typeof import("@/lib/security/command-operation-store");

  function request(cookie?: string) {
    return new NextRequest(`${ORIGIN}/api/security/approvals`, { headers: cookie ? { cookie } : {} });
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
  async function capability(projectId = PROJECT_A, identity = initiatingSession()) {
    const session = await identity;
    const authorization = await execution.createExecutionAuthorization(session.authSession, projectId);
    expect(authorization).toBeDefined();
    return { ...session, authorization: authorization! };
  }
  async function approved(input = stage()) {
    const identity = await capability();
    const scope = catalogue.buildGitOperationScope(identity.authorization, input);
    const approval = await approvals.createPrivateGitApproval(identity.authorization, scope);
    await approvals.decidePrivateGitApproval(identity.authSession, approval.id, "approved");
    return { ...identity, input, scope, approval };
  }
  async function approvedPullRequest() {
    // Repository identity is synthetic registry data only: no transport/provider
    // is instantiated and no GitHub credential or live repository is accessed.
    const repositoryUrl = "https://github.com/badadeveloper001-dev/Cr8or-Studio.git";
    await database.project.update({ where: { id: PROJECT_A }, data: { repository: repositoryUrl } });
    await database.workspace.updateMany({ where: { projectId: PROJECT_A }, data: { repositoryUrl } });
    return approved({ operation: "create-pr", branch: "main", expectedRemoteHead: HEAD,
      baseBranch: "review", expectedBase: TARGET, category: "General maintenance" });
  }
  async function approvalRow(id: string) {
    const rows = await database.$queryRaw<Array<{ consumedAt: Date | null; consumedOperationId: string | null; sessionId: string;
      credentialVersion: number; scope: GitOperationScope; scopeDigest: string }>>`SELECT * FROM "GitApproval" WHERE "id" = ${id}::uuid`;
    return rows[0];
  }
  async function expireApproval(id: string) {
    await database.$executeRaw`UPDATE "GitApproval" SET "createdAt" = NOW() - INTERVAL '11 minutes',
      "expiresAt" = NOW() - INTERVAL '1 minute', "decidedAt" = CASE WHEN "decidedAt" IS NULL THEN NULL ELSE NOW() - INTERVAL '10 minutes' END,
      "consumedAt" = CASE WHEN "consumedAt" IS NULL THEN NULL ELSE NOW() - INTERVAL '9 minutes' END WHERE "id" = ${id}::uuid`;
  }
  function reservation(overrides: Partial<import("@/lib/security/git-operation-store").ReserveGitOperationInput> = {}) {
    return { id: randomUUID(), executionId: randomUUID(), actorId: "frontend", projectId: PROJECT_A,
      workspaceId: SANDBOX_A, repositoryKey: REPOSITORY_A, operationKey: "push", scopeDigest: "a".repeat(64), ...overrides };
  }
  async function migrate(directory: string) {
    const sql = await readFile(path.join(process.cwd(), "prisma/migrations", directory, "migration.sql"), "utf8");
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter((value) => value && !/^(BEGIN|COMMIT)$/i.test(value));
    await database.$transaction(async (tx) => { for (const statement of statements) await tx.$executeRawUnsafe(statement); });
  }
  beforeAll(async () => {
    setEnvironment("NODE_ENV", "test");
    for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID", "CR8OR_WORKSPACE_MODE"]) setEnvironment(key, undefined);
    setEnvironment("CR8OR_PRIVATE_AUTH_ENABLED", "true");
    setEnvironment("CR8OR_PRIVATE_AUTH_ORIGIN", ORIGIN);
    setEnvironment("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", randomBytes(32).toString("base64url"));
    setEnvironment("CR8OR_FEATURE_AUTH_GUARD", "false");
    setEnvironment("CR8OR_FEATURE_AUDIT_LOG", "false");
    const url = new URL(testUrl!); url.search = "";
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    url.searchParams.set("schema", schemaName); url.searchParams.set("connection_limit", "5");
    setEnvironment("DATABASE_URL", url.toString()); setEnvironment("DIRECT_URL", url.toString());
    delete globalThis.prismaGlobal; vi.resetModules();
    database = (await import("@/lib/db/prisma")).prisma;
    for (const name of ["0_init", "20250101000000_add_workspace_table", "20261015000000_authentication_foundation",
      "20261016000000_command_operations", "20261016010000_command_approvals", "20261016020000_git_operations"]) await migrate(name);
    auth = await import("@/lib/security/auth"); sessions = await import("@/lib/security/session-store");
    owners = await import("@/lib/security/owner-management"); execution = await import("@/lib/security/execution-context");
    catalogue = await import("@/lib/security/git-operation-catalogue"); approvals = await import("@/lib/security/git-approvals");
    grants = await import("@/lib/security/git-authorization");
    coordinator = await import("@/lib/workspace/private-git-operations");
    operations = await import("@/lib/security/git-operation-store"); commands = await import("@/lib/security/command-operation-store");
    policy = await import("@/lib/security/policy"); legacy = await import("@/lib/security/approvals");
    await owners.provisionOwner("synthetic test code 1234");
    ownerFixture = await database.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
    // Separate module graphs and connection pools share PostgreSQL, not capabilities.
    secondDatabase = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    globalThis.prismaGlobal = secondDatabase; vi.resetModules();
    secondAuth = await import("@/lib/security/auth"); secondExecution = await import("@/lib/security/execution-context");
    secondApprovals = await import("@/lib/security/git-approvals"); secondOperations = await import("@/lib/security/git-operation-store");
    secondCommands = await import("@/lib/security/command-operation-store"); globalThis.prismaGlobal = database;
  }, 30_000);
  beforeEach(async () => {
    await database.$executeRaw`DELETE FROM "GitApproval"`;
    await database.$executeRaw`DELETE FROM "GitOperation"`;
    await database.commandOperation.deleteMany(); await database.commandApproval.deleteMany();
    await database.authSession.deleteMany(); await database.ownerCredential.deleteMany();
    await database.ownerCredential.create({ data: ownerFixture }); await database.project.deleteMany();
    for (const [id, sandbox, repo] of [[PROJECT_A, SANDBOX_A, REPOSITORY_A], [PROJECT_B, SANDBOX_B, REPOSITORY_B]]) {
      await database.project.create({ data: { id, name: "Synthetic Git project", description: "", framework: "Next.js", language: "TypeScript",
        repository: `https://github.com/${repo}`, workspaces: { create: { runtimeType: "cloud", state: "running", provider: "daytona",
          providerWorkspaceId: sandbox, repositoryUrl: `https://github.com/${repo}.git`, branch: "main" } } } });
    }
    policy.setPolicyProfile("balanced"); globalThis.__cr8orApprovalStore = { records: [] };
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
      if (previousApprovals === undefined) delete globalThis.__cr8orApprovalStore; else globalThis.__cr8orApprovalStore = previousApprovals;
      for (const [key, value] of previousEnvironment) setEnvironment(key, value);
    }
  });

  it("persists canonical repository scope while keeping session identity and credentials out of review DTOs", async () => {
    const identity = await approved();
    expect(identity.approval.scope).toMatchObject({ ownerId: "owner", projectId: PROJECT_A, providerWorkspaceId: SANDBOX_A,
      repositoryKey: REPOSITORY_A, operationKey: "stage", branch: "main", paths: ["src/app.ts"], expectedHead: HEAD, expectedIndex: INDEX });
    expect(identity.approval.preview).toBe(JSON.stringify(identity.scope, null, 2));
    const row = await approvalRow(identity.approval.id);
    expect(row).toMatchObject({ sessionId: identity.session.id, credentialVersion: ownerFixture.credentialVersion,
      scopeDigest: catalogue.gitScopeDigest(identity.scope), consumedAt: null });
    for (const secret of [identity.token, identity.session.id, ownerFixture.accessCodeHash]) expect(JSON.stringify(identity.approval)).not.toContain(secret);
  });
  it("caps approval lifetime at the originating session expiration", async () => {
    const identity = await capability(PROJECT_A, initiatingSession(60_000));
    const approval = await approvals.createPrivateGitApproval(identity.authorization, catalogue.buildGitOperationScope(identity.authorization, stage()));
    expect(new Date(approval.expiresAt).getTime()).toBe(identity.session.expiresAt.getTime());
  });
  it("persists immutable pull-request naming inputs with the existing ten-minute session-bound approval", async () => {
    const identity = await approvedPullRequest();
    const row = await approvalRow(identity.approval.id);
    expect(row.scope).toMatchObject({ operationKey: "create-pr", repositoryKey: "badadeveloper001-dev/cr8or-studio",
      expectedRemoteHead: HEAD, baseBranch: "review", expectedBase: TARGET, category: "General maintenance",
      pullRequestNaming: { version: 2, projectCode: "CR8OR", strategy: "approved-head-commit" } });
    expect(row).toMatchObject({ sessionId: identity.session.id, credentialVersion: ownerFixture.credentialVersion,
      scopeDigest: catalogue.gitScopeDigest(identity.scope) });
    expect(new Date(identity.approval.expiresAt).getTime() - new Date(identity.approval.requestedAt).getTime()).toBe(10 * 60 * 1_000);
    expect(identity.approval.preview).toBe(JSON.stringify(identity.scope, null, 2));
    const operationId = randomUUID();
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "frontend")).toBe(true);
    expect(await approvals.validateConsumedPrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "frontend")).toBe(true);
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
  });
  it.each([
    ["approved head", { expectedRemoteHead: "a".repeat(40) }], ["category", { category: "Test improvements" }],
    ["base branch", { baseBranch: "different-review" }], ["base head", { expectedBase: "b".repeat(40) }],
    ["project code", { pullRequestNaming: { version: 2, projectCode: "OTHER", strategy: "approved-head-commit" } }],
    ["strategy", { pullRequestNaming: { version: 2, projectCode: "CR8OR", strategy: "next-available" } }],
    ["missing naming", { pullRequestNaming: undefined }], ["repository", { repositoryKey: REPOSITORY_B }],
  ])("cannot consume a pull-request approval with changed %s", async (_name, changed) => {
    const identity = await approvedPullRequest();
    const consumed = await approvals.consumePrivateGitApproval(identity.authorization,
      { ...identity.scope, ...(changed as object) }, identity.approval.id, randomUUID(), "frontend").catch(() => false);
    expect(consumed).toBe(false);
    expect((await approvalRow(identity.approval.id)).consumedAt).toBeNull();
  });
  it("does not silently upgrade a persisted legacy pull-request approval lacking naming inputs", async () => {
    const identity = await approvedPullRequest();
    const stageApproval = await approvals.createPrivateGitApproval(identity.authorization,
      catalogue.buildGitOperationScope(identity.authorization, stage()));
    await database.$executeRaw`UPDATE "GitApproval" SET "scope" = "scope" - 'pullRequestNaming'
      WHERE "id" = ${identity.approval.id}::uuid`;
    const listed = await approvals.listPrivateGitApprovals(identity.authSession);
    expect(listed.map(item => item.id)).toEqual([stageApproval.id]);
    expect(listed[0].scope.operationKey).toBe("stage");
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
    const retained = await approvalRow(identity.approval.id);
    expect(retained.consumedAt).toBeNull();
    expect(retained.scope).not.toHaveProperty("pullRequestNaming");
  });
  it("rejects the previous successor allocation policy without rewriting its approval record", async () => {
    const identity = await approvedPullRequest();
    const legacyNaming = JSON.stringify({ version: 1, projectCode: "CR8OR", strategy: "approved-head-successor" });
    await database.$executeRaw`UPDATE "GitApproval" SET "scope" = jsonb_set("scope", '{pullRequestNaming}', ${legacyNaming}::jsonb)
      WHERE "id" = ${identity.approval.id}::uuid`;
    expect(await approvals.listPrivateGitApprovals(identity.authSession)).toEqual([]);
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
    const row = await approvalRow(identity.approval.id);
    expect(row.consumedAt).toBeNull();
    expect(row.scope.pullRequestNaming).toEqual(JSON.parse(legacyNaming));
  });

  it.each(["commit", "upsert-file"] as const)("persists immutable naming policy for %s without upgrading old approvals", async operation => {
    const input: GitOperationRequest = operation === "commit" ? { operation, branch: "main", expectedHead: HEAD,
      expectedIndex: INDEX, category: "General maintenance" } : { operation, branch: "main", expectedRemoteHead: HEAD,
      filePath: "src/app.ts", expectedBlob: TARGET, content: "synthetic update\n", category: "General maintenance" };
    const identity = await approved(input);
    expect(identity.scope.commitNaming).toEqual({ version: 1, projectCode: "CR8OR", strategy: "registered-history-next" });
    expect((await approvalRow(identity.approval.id)).scope.commitNaming).toEqual(identity.scope.commitNaming);
    for (const changed of [
      { category: "Test improvements" }, { commitNaming: { version: 1, projectCode: "PROJECT", strategy: "registered-history-next" } },
      { commitNaming: { version: 1, projectCode: "CR8OR", strategy: "next-available" } }, { commitNaming: undefined },
      operation === "commit" ? { expectedHead: TARGET } : { expectedRemoteHead: TARGET },
      operation === "commit" ? { expectedIndex: "f".repeat(64) } : { contentDigest: "f".repeat(64) },
      operation === "commit" ? { expectedHead: "e".repeat(40) } : { expectedBlob: "e".repeat(40) },
    ]) {
      expect(await approvals.consumePrivateGitApproval(identity.authorization, { ...identity.scope, ...(changed as object) },
        identity.approval.id, randomUUID(), "frontend").catch(() => false)).toBe(false);
    }
    expect((await approvalRow(identity.approval.id)).consumedAt).toBeNull();
    await database.$executeRaw`UPDATE "GitApproval" SET "scope" = "scope" - 'commitNaming'
      WHERE "id" = ${identity.approval.id}::uuid`;
    expect(await approvals.listPrivateGitApprovals(identity.authSession)).toEqual([]);
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
    const retained = await approvalRow(identity.approval.id);
    expect(retained.scope).not.toHaveProperty("commitNaming");
    expect(retained.consumedAt).toBeNull();
    const fresh = await approvals.createPrivateGitApproval(identity.authorization, identity.scope);
    await approvals.decidePrivateGitApproval(identity.authSession, fresh.id, "approved");
    const operationId = randomUUID();
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, fresh.id, operationId, "frontend")).toBe(true);
    expect(await approvals.validateConsumedPrivateGitApproval(identity.authorization, identity.scope, fresh.id, operationId, "frontend")).toBe(true);
  });
  it.each(["revoked", "expired", "rotated"] as const)("keeps pull-request approval invalid when its initiating session is %s", async state => {
    const identity = await approvedPullRequest();
    if (state === "revoked") await sessions.revokeSession(identity.session.id);
    if (state === "expired") await database.authSession.update({ where: { id: identity.session.id }, data: {
      authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) } });
    if (state === "rotated") await owners.rotateOwnerAccessCode("synthetic pull-request replacement 1234");
    await expect(approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend"))
      .rejects.toMatchObject({ status: 401 });
    const fresh = await capability();
    expect(await approvals.consumePrivateGitApproval(fresh.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
  });
  it.each([null, "https://github.com/unrelated/repository", "https://token@github.com/synthetic-owner/repository-a"])(
    "requires matching registered Project and Workspace repositories: %s", async (repository) => {
      const identity = await capability();
      await database.project.update({ where: { id: PROJECT_A }, data: { repository } });
      await expect(approvals.createPrivateGitApproval(identity.authorization, catalogue.buildGitOperationScope(identity.authorization, stage())))
        .rejects.toMatchObject({ status: 409 });
    });
  it("rejects unknown projects before approval creation", async () => {
    const identity = await initiatingSession();
    await expect(execution.createExecutionAuthorization(identity.authSession, "unregistered-synthetic-project")).rejects.toMatchObject({ status: 404 });
  });
  it("rejects a fabricated session and a copied capability even with genuine scope fields", async () => {
    const identity = await approved();
    await expect(approvals.decidePrivateGitApproval({ userId: "owner", role: "owner", provider: "private-session", authenticated: true } as AuthSession,
      identity.approval.id, "revoked")).rejects.toMatchObject({ status: 401 });
    await expect(approvals.createPrivateGitApproval({ ...identity.authorization } as ExecutionAuthorizationContext, identity.scope))
      .rejects.toMatchObject({ status: 401 });
    await expect(approvals.createPrivateGitApproval(undefined as unknown as ExecutionAuthorizationContext, identity.scope))
      .rejects.toMatchObject({ status: 401 });
  });
  it.each(["project", "sandbox", "repository", "registration", "branch"] as const)("does not consume an approval after %s remapping", async (field) => {
    const identity = await approved();
    if (field === "project") {
      const other = await capability(PROJECT_B, Promise.resolve(identity));
      expect(await approvals.consumePrivateGitApproval(other.authorization, catalogue.buildGitOperationScope(other.authorization, stage()), identity.approval.id, randomUUID(), "frontend")).toBe(false);
    } else {
      if (field === "sandbox") await database.workspace.updateMany({ where: { projectId: PROJECT_A }, data: { providerWorkspaceId: `${SANDBOX_A}-new` } });
      if (field === "repository") await database.project.update({ where: { id: PROJECT_A }, data: { repository: `https://github.com/${REPOSITORY_B}` } });
      if (field === "branch") await database.workspace.updateMany({ where: { projectId: PROJECT_A }, data: { branch: "different" } });
      if (field === "registration") {
        await database.workspace.deleteMany({ where: { projectId: PROJECT_A } });
        await database.workspace.create({ data: { projectId: PROJECT_A, runtimeType: "cloud", state: "running", provider: "daytona",
          providerWorkspaceId: SANDBOX_A, repositoryUrl: `https://github.com/${REPOSITORY_A}.git`, branch: "main" } });
      }
      const fresh = await execution.createExecutionAuthorization(identity.authSession, PROJECT_A);
      expect(await approvals.consumePrivateGitApproval(fresh!, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
    }
    expect((await approvalRow(identity.approval.id)).consumedAt).toBeNull();
  });
  it("rejects duplicate Daytona sandbox bindings", async () => {
    const identity = await approved();
    await database.workspace.updateMany({ where: { projectId: PROJECT_B }, data: { providerWorkspaceId: SANDBOX_A } });
    await expect(approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend"))
      .rejects.toMatchObject({ status: 409 });
  });
  it.each([
    ["operation", { operationKey: "unstage" }], ["branch", { branch: "other" }], ["files", { paths: ["src/different.ts"] }],
    ["head", { expectedHead: TARGET }], ["index", { expectedIndex: "f".repeat(64) }], ["payload", { payloadDigest: "f".repeat(64) }],
    ["owner", { ownerId: "attacker" }], ["workspace", { providerWorkspaceId: SANDBOX_B }], ["repository", { repositoryKey: REPOSITORY_B }],
  ])("cannot spend approval on mismatched %s", async (_name, changed) => {
    const identity = await approved();
    const result = await approvals.consumePrivateGitApproval(identity.authorization, { ...identity.scope, ...(changed as object) }, identity.approval.id, randomUUID(), "frontend").catch(() => false);
    expect(result).toBe(false); expect((await approvalRow(identity.approval.id)).consumedAt).toBeNull();
  });
  it.each(["targetCommit", "expectedRemoteHead"] as const)("binds push approval to exact %s", async (field) => {
    const identity = await approved(push());
    expect(await approvals.consumePrivateGitApproval(identity.authorization, { ...identity.scope, [field]: "a".repeat(40) }, identity.approval.id, randomUUID(), "frontend")).toBe(false);
  });
  it("binds update-file approval to exact content without persisting raw contents", async () => {
    const content = "synthetic private source Ω\n";
    const identity = await approved({ operation: "upsert-file", branch: "main", expectedRemoteHead: HEAD, expectedBlob: TARGET,
      filePath: "src/app.ts", content, category: "Code improvements" });
    const changed = catalogue.buildGitOperationScope(identity.authorization, { ...identity.input, content: "different" } as GitOperationRequest);
    expect(await approvals.consumePrivateGitApproval(identity.authorization, changed, identity.approval.id, randomUUID(), "frontend")).toBe(false);
    expect(JSON.stringify(await approvalRow(identity.approval.id))).not.toContain(content);
  });
  it("consumes exactly once and validates only the exact operation and actor receipt", async () => {
    const identity = await approved(), operationId = randomUUID();
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "frontend")).toBe(true);
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "frontend")).toBe(false);
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
    expect(await approvals.validateConsumedPrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "frontend")).toBe(true);
    expect(await approvals.validateConsumedPrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "backend")).toBe(false);
    expect(await approvals.validateConsumedPrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
  });
  it("allows one consumption across independent application instances", async () => {
    const identity = await approved();
    const otherSession = await secondAuth.resolveAuthSession(request(identity.cookie), false);
    const other = await secondExecution.createExecutionAuthorization(otherSession!, PROJECT_A);
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => index % 2
      ? approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")
      : secondApprovals.consumePrivateGitApproval(other!, identity.scope, identity.approval.id, randomUUID(), "frontend")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("does not consume a second approval using the same operation identifier", async () => {
    const identity = await approved(), operationId = randomUUID();
    const additional = await approvals.createPrivateGitApproval(identity.authorization, identity.scope);
    await approvals.decidePrivateGitApproval(identity.authSession, additional.id, "approved");
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "frontend")).toBe(true);
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, additional.id, operationId, "frontend")).toBe(false);
  });
  it.each(["pending", "denied", "revoked", "expired"] as const)("rejects %s approvals", async (state) => {
    const identity = await capability(), scope = catalogue.buildGitOperationScope(identity.authorization, stage());
    const approval = await approvals.createPrivateGitApproval(identity.authorization, scope);
    if (state === "denied" || state === "revoked") await approvals.decidePrivateGitApproval(identity.authSession, approval.id, state);
    if (state === "expired") { await approvals.decidePrivateGitApproval(identity.authSession, approval.id, "approved"); await expireApproval(approval.id); }
    expect(await approvals.consumePrivateGitApproval(identity.authorization, scope, approval.id, randomUUID(), "frontend")).toBe(false);
  });
  it.each(["revoked", "expired", "rotated", "revoke-all"] as const)("rejects previously valid approval when session is %s", async (state) => {
    const identity = await approved();
    if (state === "revoked") await sessions.revokeSession(identity.session.id);
    if (state === "expired") await database.authSession.update({ where: { id: identity.session.id }, data: {
      authenticatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) } });
    if (state === "rotated") await owners.rotateOwnerAccessCode("synthetic replacement 1234");
    if (state === "revoke-all") await sessions.revokeAllOwnerSessions();
    await expect(approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).rejects.toMatchObject({ status: 401 });
    const fresh = await capability();
    expect(await approvals.consumePrivateGitApproval(fresh.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
  });
  it("requires a separate approval for another owner device", async () => {
    const identity = await approved(), another = await capability();
    await expect(approvals.decidePrivateGitApproval(another.authSession, identity.approval.id, "revoked")).rejects.toMatchObject({ status: 409 });
    expect(await approvals.consumePrivateGitApproval(another.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend")).toBe(false);
  });
  it("revocation invalidates a consumed approval receipt without erasing its audit record", async () => {
    const identity = await approved(), operationId = randomUUID();
    expect(await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "frontend")).toBe(true);
    await approvals.decidePrivateGitApproval(identity.authSession, identity.approval.id, "revoked");
    expect(await approvals.validateConsumedPrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, operationId, "frontend")).toBe(false);
    expect((await approvalRow(identity.approval.id)).consumedOperationId).toBe(operationId);
  });
  it("never upgrades generic action-only approvals or unknown identifiers", async () => {
    const identity = await capability(), scope = catalogue.buildGitOperationScope(identity.authorization, push());
    const generic = legacy.requestApproval({ action: "git.commit-push", title: "Safe-looking title", preview: JSON.stringify(scope), requestedBy: "owner", requestedRole: "owner" });
    legacy.decideApproval({ id: generic.id, decision: "approved", decidedBy: "owner", decidedRole: "owner" });
    expect(await approvals.consumePrivateGitApproval(identity.authorization, scope, generic.id, randomUUID(), "frontend")).toBe(false);
    expect(await approvals.consumePrivateGitApproval(identity.authorization, scope, randomUUID(), randomUUID(), "frontend")).toBe(false);
    expect(legacy.listApprovals()[0].consumedAt).toBeUndefined();
  });
  it("denies sanitized approval requests when PostgreSQL approval storage is unavailable", async () => {
    const identity = await approved();
    await database.$executeRawUnsafe('ALTER TABLE "GitApproval" RENAME TO "GitApprovalUnavailable"');
    try {
      const error = await approvals.consumePrivateGitApproval(identity.authorization, identity.scope, identity.approval.id, randomUUID(), "frontend").catch((value: unknown) => value);
      expect(error).toMatchObject({ status: 503, message: "Git approval storage is unavailable." });
      await expect(approvals.createPrivateGitApproval(identity.authorization, identity.scope)).rejects.toMatchObject({ status: 503 });
      await expect(approvals.listPrivateGitApprovals(identity.authSession)).rejects.toMatchObject({ status: 503 });
      expect(String(error)).not.toContain(identity.token); expect(String(error)).not.toContain(process.env.DATABASE_URL);
    } finally { await database.$executeRawUnsafe('ALTER TABLE "GitApprovalUnavailable" RENAME TO "GitApproval"'); }
  });

  it.each([undefined, `cr8or-dev-session=${randomBytes(32).toString("base64url")}`])("requires a genuine cookie before establishing a Git context", async (cookie) => {
    expect(await auth.resolveAuthSession(request(cookie), false)).toBeNull();
  });
  it("mints a read grant without granting write permission or consuming approval", async () => {
    const identity = await initiatingSession();
    const context = await execution.createExecutionAuthorization(identity.authSession, PROJECT_A, { permissions: ["read"] });
    const grant = await grants.authorizeOwnerGitOperation(context!, { operation: "status" }, identity.authSession);
    expect(await grants.validateGitAuthorization(grant, context!, { operation: "status" })).toMatchObject({ actorId: "owner", scope: { operationKey: "status", repositoryKey: REPOSITORY_A } });
    await expect(grants.authorizeOwnerGitOperation(context!, stage(), identity.authSession)).rejects.toMatchObject({ status: 403 });
  });
  it.each(["balanced", "strict"] as const)("requires and revalidates an exact durable approval under %s policy", async (profile) => {
    policy.setPolicyProfile(profile);
    const identity = await approved();
    await expect(grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession)).rejects.toMatchObject({ status: 409 });
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession, identity.approval.id);
    expect(await grants.validateGitAuthorization(grant, identity.authorization, identity.input)).toMatchObject({ scope: identity.scope });
    await expect(grants.validateGitAuthorization(grant, identity.authorization, { ...stage(), paths: ["src/other.ts"] } as GitOperationRequest)).rejects.toMatchObject({ status: 409 });
    await approvals.decidePrivateGitApproval(identity.authSession, identity.approval.id, "revoked");
    await expect(grants.validateGitAuthorization(grant, identity.authorization, identity.input)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects action-only approval at the opaque grant boundary", async () => {
    const identity = await capability();
    const generic = legacy.requestApproval({ action: "github.write", title: "Approval", preview: "Trusted-looking operation", requestedBy: "owner", requestedRole: "owner" });
    legacy.decideApproval({ id: generic.id, decision: "approved", decidedBy: "owner", decidedRole: "owner" });
    await expect(grants.authorizeOwnerGitOperation(identity.authorization, push(), identity.authSession, generic.id)).rejects.toMatchObject({ status: 409 });
    expect(legacy.listApprovals()[0].consumedAt).toBeUndefined();
  });
  it("rejects another session, client owner claims and fabricated grants", async () => {
    const identity = await capability(), another = await initiatingSession();
    await expect(grants.authorizeOwnerGitOperation(identity.authorization, { operation: "status" }, another.authSession)).rejects.toMatchObject({ status: 401 });
    await expect(grants.authorizeOwnerGitOperation(identity.authorization, { operation: "status" }, { ...identity.authSession })).rejects.toMatchObject({ status: 401 });
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, { operation: "status" }, identity.authSession);
    await expect(grants.validateGitAuthorization({ ...grant } as typeof grant, identity.authorization, { operation: "status" })).rejects.toMatchObject({ status: 403 });
  });
  it.each(["research", "security", "main-chat", "invented-writer"])("does not upgrade %s through a fabricated owner role", async (actorId) => {
    policy.setPolicyProfile("autonomous");
    const identity = await capability();
    await expect(grants.authorizeAgentGitOperation(identity.authorization, stage(), { actorId, actorRole: "owner", projectId: PROJECT_A,
      authorization: identity.authorization, workspaceRoot: "/unused", requestId: "synthetic-test" })).rejects.toMatchObject({ status: 403 });
  });
  it("permits the server-selected writer's exact approved operation", async () => {
    const identity = await approved();
    const grant = await grants.authorizeAgentGitOperation(identity.authorization, identity.input, { actorId: "frontend", actorRole: "agent", projectId: PROJECT_A,
      authorization: identity.authorization, workspaceRoot: "/unused", requestId: "synthetic-test", approvalId: identity.approval.id });
    expect(await grants.validateGitAuthorization(grant, identity.authorization, identity.input)).toMatchObject({ actorId: "frontend", scope: identity.scope });
  });
  it("rejects a tool context that substitutes project scope", async () => {
    const identity = await capability();
    await expect(grants.authorizeAgentGitOperation(identity.authorization, { operation: "status" }, { actorId: "frontend", actorRole: "agent", projectId: PROJECT_B,
      authorization: identity.authorization, workspaceRoot: "/unused", requestId: "synthetic-test" })).rejects.toMatchObject({ status: 403 });
  });
  it("revalidates owner session after a read grant was minted", async () => {
    const identity = await capability();
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, { operation: "status" }, identity.authSession);
    await sessions.revokeSession(identity.session.id);
    await expect(grants.validateGitAuthorization(grant, identity.authorization, { operation: "status" })).rejects.toMatchObject({ status: 401 });
  });
  it("preserves autonomous approval exemption without bypassing authentication or policy changes", async () => {
    const identity = await capability(); policy.setPolicyProfile("autonomous");
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, stage(), identity.authSession);
    expect(await grants.validateGitAuthorization(grant, identity.authorization, stage())).toMatchObject({ scope: { operationKey: "stage" } });
    policy.setPolicyProfile("balanced");
    await expect(grants.validateGitAuthorization(grant, identity.authorization, stage())).rejects.toMatchObject({ status: 409 });
    await expect(grants.authorizeOwnerGitOperation(undefined as unknown as ExecutionAuthorizationContext, stage(), identity.authSession)).rejects.toMatchObject({ status: 401 });
  });

  it.each(["stage", "commit", "push"] as const)("executes an approved %s through real grant and PostgreSQL coordination once", async (kind) => {
    const input = kind === "stage" ? stage() : kind === "push" ? push() : {
      operation: "commit", branch: "main", expectedHead: HEAD, expectedIndex: INDEX, category: "Code improvements",
    } satisfies GitOperationRequest;
    const identity = await approved(input);
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession, identity.approval.id);
    const execute = vi.fn<import("@/lib/workspace/private-git-operations").GitExecutionAdapter["execute"]>(async (_request, scope, revalidate, signal) => {
      expect(signal.aborted).toBe(false);
      await revalidate();
      expect(scope).toEqual(identity.scope);
      return { status: "SUCCEEDED", data: { verified: true }, cancellationConfirmed: true, cleanupConfirmed: true };
    });
    const adapter = { kind: kind === "push" ? "github" as const : "daytona" as const, execute };
    const result = await coordinator.executeAuthorizedGitOperation(grant, identity.authorization, identity.input, adapter);
    expect(result).toMatchObject({ status: "SUCCEEDED", data: { verified: true }, cancellationConfirmed: true, cleanupConfirmed: true });
    expect(await operations.readGitOperation(result.operationId)).toMatchObject({ status: "SUCCEEDED", exitCode: 0,
      projectId: PROJECT_A, workspaceId: SANDBOX_A, repositoryKey: REPOSITORY_A, operationKey: kind, actorId: "owner" });
    expect((await approvalRow(identity.approval.id)).consumedOperationId).toBe(result.operationId);
    await expect(coordinator.executeAuthorizedGitOperation(grant, identity.authorization, identity.input, adapter)).rejects.toMatchObject({ status: 409 });
    expect(execute).toHaveBeenCalledTimes(1);
    for (const secret of [identity.token, identity.session.id, ownerFixture.accessCodeHash]) {
      expect(JSON.stringify(execute.mock.calls)).not.toContain(secret);
    }
  });
  it("denies owner revocation before dispatch without invoking the adapter or reserving an operation", async () => {
    const identity = await approved();
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession, identity.approval.id);
    await sessions.revokeSession(identity.session.id);
    const execute = vi.fn();
    await expect(coordinator.executeAuthorizedGitOperation(grant, identity.authorization, identity.input, { kind: "daytona", execute })).rejects.toMatchObject({ status: 401 });
    expect(execute).not.toHaveBeenCalled();
    const [row] = await database.$queryRaw<Array<{ count: number }>>`SELECT count(*)::integer AS "count" FROM "GitOperation"`;
    expect(row.count).toBe(0);
  });
  it("withholds provider output and retains UNKNOWN when owner revocation is detected after dispatch", async () => {
    const identity = await approved();
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession, identity.approval.id);
    const metadata = await grants.validateGitAuthorization(grant, identity.authorization, identity.input);
    const execute = vi.fn<import("@/lib/workspace/private-git-operations").GitExecutionAdapter["execute"]>(async () => {
      await sessions.revokeSession(identity.session.id);
      return { status: "SUCCEEDED", data: { privateOutput: "never-release-this-synthetic-output" }, cancellationConfirmed: true, cleanupConfirmed: true };
    });
    const error = await coordinator.executeAuthorizedGitOperation(grant, identity.authorization, identity.input, { kind: "daytona", execute }).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "ExecutionAuthorizationError" });
    expect(error).not.toHaveProperty("data");
    expect(String(error)).not.toContain("never-release-this-synthetic-output");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await operations.readGitOperation(metadata.operationId)).toMatchObject({ status: "UNKNOWN", cancellationConfirmed: false, cleanupConfirmed: false });
  });
  it("retains an uncertain push reservation and refuses a fresh approval's automatic retry", async () => {
    const identity = await approved(push());
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession, identity.approval.id);
    const execute = vi.fn<import("@/lib/workspace/private-git-operations").GitExecutionAdapter["execute"]>(async () => ({
      status: "UNKNOWN", data: { unverifiedHead: TARGET }, cancellationConfirmed: false, cleanupConfirmed: false,
    }));
    const adapter = { kind: "github" as const, execute };
    const result = await coordinator.executeAuthorizedGitOperation(grant, identity.authorization, identity.input, adapter);
    expect(result.status).toBe("UNKNOWN"); expect(result).not.toHaveProperty("data");
    expect(await operations.readGitOperation(result.operationId)).toMatchObject({ status: "UNKNOWN", exitCode: null });
    const additional = await approvals.createPrivateGitApproval(identity.authorization, identity.scope);
    await approvals.decidePrivateGitApproval(identity.authSession, additional.id, "approved");
    const retryGrant = await grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession, additional.id);
    await expect(coordinator.executeAuthorizedGitOperation(retryGrant, identity.authorization, identity.input, adapter)).rejects.toMatchObject({ status: 409 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("sanitizes provider exceptions and records their ambiguous dispatched outcome", async () => {
    const identity = await approved(push());
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession, identity.approval.id);
    const metadata = await grants.validateGitAuthorization(grant, identity.authorization, identity.input);
    const execute = vi.fn(async () => { throw new Error("provider secret synthetic-token-in-sensitive-url"); });
    const error = await coordinator.executeAuthorizedGitOperation(grant, identity.authorization, identity.input, { kind: "github", execute }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503 }); expect(String(error)).not.toContain("synthetic-token");
    expect(await operations.readGitOperation(metadata.operationId)).toMatchObject({ status: "UNKNOWN" });
  });
  it("respects cancellation during adapter execution without reporting success or releasing the mutation slot", async () => {
    const identity = await approved();
    const grant = await grants.authorizeOwnerGitOperation(identity.authorization, identity.input, identity.authSession, identity.approval.id);
    const metadata = await grants.validateGitAuthorization(grant, identity.authorization, identity.input);
    const execute = vi.fn<import("@/lib/workspace/private-git-operations").GitExecutionAdapter["execute"]>(async (_request, _scope, _revalidate, signal) => {
      execution.cancelExecutionAuthorization(identity.authorization);
      expect(signal.aborted).toBe(true);
      return { status: "SUCCEEDED", data: { completionUnverified: true }, cancellationConfirmed: false, cleanupConfirmed: false };
    });
    await expect(coordinator.executeAuthorizedGitOperation(grant, identity.authorization, identity.input, { kind: "daytona", execute })).rejects.toMatchObject({ name: "ExecutionAuthorizationError" });
    expect(await operations.readGitOperation(metadata.operationId)).toMatchObject({ status: "UNKNOWN" });
  });
  it("rejects a reviewer before any coordinator adapter dispatch", async () => {
    const identity = await approved();
    const execute = vi.fn();
    const run = async () => {
      const grant = await grants.authorizeAgentGitOperation(identity.authorization, identity.input, { actorId: "security", actorRole: "owner",
        projectId: PROJECT_A, authorization: identity.authorization, workspaceRoot: "/unused", requestId: "synthetic-reviewer", approvalId: identity.approval.id });
      return coordinator.executeAuthorizedGitOperation(grant, identity.authorization, identity.input, { kind: "daytona", execute });
    };
    await expect(run()).rejects.toMatchObject({ status: 403 }); expect(execute).not.toHaveBeenCalled();
    expect((await approvalRow(identity.approval.id)).consumedAt).toBeNull();
  });

  it("allows one concurrent reservation per repository across application instances and sandboxes", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => index % 2
      ? operations.reserveGitOperation(reservation())
      : secondOperations.reserveGitOperation(reservation({ projectId: PROJECT_B, workspaceId: SANDBOX_B }))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
  it("blocks conflicting mutations in one sandbox even for different repository keys", async () => {
    await operations.reserveGitOperation(reservation());
    await expect(secondOperations.reserveGitOperation(reservation({ repositoryKey: REPOSITORY_B }))).rejects.toMatchObject({ status: 409 });
  });
  it("allows independent registered repository and sandbox operations", async () => {
    await operations.reserveGitOperation(reservation());
    await expect(secondOperations.reserveGitOperation(reservation({ projectId: PROJECT_B, workspaceId: SANDBOX_B, repositoryKey: REPOSITORY_B }))).resolves.toBeUndefined();
  });
  it("blocks Git while a development command owns the workspace slot", async () => {
    await commands.reserveCommandOperation({ id: randomUUID(), executionId: randomUUID(), projectId: PROJECT_A, workspaceId: SANDBOX_A, actorId: "frontend", commandKey: "npm test" });
    await expect(operations.reserveGitOperation(reservation())).rejects.toMatchObject({ status: 409 });
  });
  it("blocks a development command while Git owns the workspace slot", async () => {
    await operations.reserveGitOperation(reservation());
    await expect(secondCommands.reserveCommandOperation({ id: randomUUID(), executionId: randomUUID(), projectId: PROJECT_A,
      workspaceId: SANDBOX_A, actorId: "frontend", commandKey: "npm test" })).rejects.toMatchObject({ status: 409 });
  });
  it("serializes a cross-instance Git versus command reservation race", async () => {
    const results = await Promise.allSettled([operations.reserveGitOperation(reservation()), secondCommands.reserveCommandOperation({
      id: randomUUID(), executionId: randomUUID(), projectId: PROJECT_A, workspaceId: SANDBOX_A, actorId: "frontend", commandKey: "npm test" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
  it("dispatches once and rejects duplicate commit or push dispatch", async () => {
    const input = reservation(); await operations.reserveGitOperation(input);
    const claims = await Promise.allSettled([operations.markGitDispatched(input.id), secondOperations.markGitDispatched(input.id)]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(await operations.readGitOperation(input.id)).toMatchObject({ status: "RUNNING", exitCode: null });
    await expect(operations.reserveGitOperation(input)).rejects.toMatchObject({ status: 409 });
  });
  it("retains UNKNOWN outcomes across cleanup and prevents automatic retry", async () => {
    const input = reservation(); await operations.reserveGitOperation(input); await operations.markGitDispatched(input.id);
    await operations.finishGitOperation(input.id, { status: "UNKNOWN" });
    await database.$executeRaw`UPDATE "GitOperation" SET "createdAt" = NOW() - INTERVAL '100 days', "completedAt" = NOW() - INTERVAL '99 days' WHERE "id" = ${input.id}::uuid`;
    expect(await operations.cleanupCompletedGitOperations()).toBe(0);
    await expect(operations.reserveGitOperation(reservation())).rejects.toMatchObject({ status: 409 });
    await expect(operations.finishGitOperation(input.id, { status: "SUCCEEDED", exitCode: 0, cancellationConfirmed: true, cleanupConfirmed: true })).rejects.toMatchObject({ status: 409 });
    expect(await operations.readGitOperation(input.id)).toMatchObject({ status: "UNKNOWN", cancellationConfirmed: false });
  });
  it.each(["SUCCEEDED", "TIMED_OUT", "CANCELLED", "FAILED"] as const)("does not release a running slot as %s without provider completion and cleanup evidence", async (status) => {
    const input = reservation(); await operations.reserveGitOperation(input); await operations.markGitDispatched(input.id);
    await expect(operations.finishGitOperation(input.id, { status, ...(status === "SUCCEEDED" ? { exitCode: 0 } : {}) })).rejects.toMatchObject({ status: 409 });
    expect(await operations.readGitOperation(input.id)).toMatchObject({ status: "RUNNING" });
  });
  it("enforces the shared rate window even after confirmed successful operations", async () => {
    for (let index = 0; index < operations.GIT_MAX_STARTS_PER_WINDOW; index++) {
      const input = reservation(); await operations.reserveGitOperation(input); await operations.markGitDispatched(input.id);
      await operations.finishGitOperation(input.id, { status: "SUCCEEDED", exitCode: 0, cancellationConfirmed: true, cleanupConfirmed: true });
    }
    await expect(secondOperations.reserveGitOperation(reservation())).rejects.toMatchObject({ status: 409 });
  });
  it("never reserves unknown operations or read-only operations as mutations", async () => {
    await expect(operations.reserveGitOperation(reservation({ operationKey: "arbitrary-shell" }))).rejects.toMatchObject({ status: 409 });
    await expect(operations.reserveGitOperation(reservation({ operationKey: "status" }))).rejects.toMatchObject({ status: 409 });
  });
  it("denies coordination with sanitized errors when its database table is unavailable", async () => {
    await database.$executeRawUnsafe('ALTER TABLE "GitOperation" RENAME TO "GitOperationUnavailable"');
    try {
      await expect(operations.reserveGitOperation(reservation())).rejects.toMatchObject({ status: 503, message: "Git coordination is unavailable." });
      await expect(operations.readGitOperation(randomUUID())).rejects.toMatchObject({ status: 503 });
    } finally { await database.$executeRawUnsafe('ALTER TABLE "GitOperationUnavailable" RENAME TO "GitOperation"'); }
  });
  it("retains every release gate regardless of autonomous policy", async () => {
    policy.setPolicyProfile("autonomous");
    const gitGate = await import("@/lib/workspace/private-git-availability");
    const commandGate = await import("@/lib/workspace/private-cloud-command-availability");
    const writeGate = await import("@/lib/workspace/private-cloud-write-availability");
    expect(() => gitGate.assertPrivateGitAvailable()).toThrow();
    expect(() => commandGate.assertPrivateCloudCommandAvailable()).toThrow();
    expect(() => writeGate.assertPrivateCloudWriteTransportAvailable()).toThrow();
  });
});
