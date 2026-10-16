import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the actual route exports and central authentication/authorization.
// Only persistence and the work behind the authorization boundary are replaced.
const mocks = vi.hoisted(() => ({
  resolveOwnerSession: vi.fn(),
  projectFindMany: vi.fn(), projectCreate: vi.fn(),
  cloudList: vi.fn(), cloudCreate: vi.fn(), cloudOpen: vi.fn(), cloudFind: vi.fn(),
  cloudMode: vi.fn(), workspaceRuntime: vi.fn(), workspaceConfig: vi.fn(),
  orchestrate: vi.fn(), agentLLM: vi.fn(), agentTools: vi.fn(), toolPreset: vi.fn(),
  inspectWorkspace: vi.fn(), inspectReadiness: vi.fn(),
  secret: vi.fn(), secretFallback: vi.fn(), secretReadiness: vi.fn(),
  sandboxRun: vi.fn(), sandboxCancel: vi.fn(), sandboxSnapshot: vi.fn(),
  policyGuard: vi.fn(), policyProfile: vi.fn(), policyRules: vi.fn(), policySet: vi.fn(),
  approvalList: vi.fn(), approvalRequest: vi.fn(), approvalDecide: vi.fn(),
  auditAppend: vi.fn(), auditRead: vi.fn(), supabase: vi.fn(), fetch: vi.fn(),
  projectsRoot: vi.fn(), projectFiles: vi.fn(), projectRecent: vi.fn(),
}));

vi.mock("@/lib/security/session-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security/session-store")>(),
  resolveOwnerSession: mocks.resolveOwnerSession,
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: {
  project: { findMany: mocks.projectFindMany, create: mocks.projectCreate },
} }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseClient: mocks.supabase }));
vi.mock("@/lib/workspace/cloud-service", () => ({
  listCloudProjects: mocks.cloudList, createCloudProject: mocks.cloudCreate, openCloudProject: mocks.cloudOpen,
}));
vi.mock("@/lib/workspace/cloud-projects", () => ({
  findCloudProject: mocks.cloudFind, cloudModeEnabled: mocks.cloudMode,
}));
vi.mock("@/lib/workspace/runtime-factory", () => ({
  getWorkspaceRuntime: mocks.workspaceRuntime, getWorkspaceConfig: mocks.workspaceConfig,
}));
vi.mock("@/lib/workspace/workspace-inspection", () => ({
  performReadOnlyTaskLoop: mocks.inspectWorkspace, performLocalReadinessCheck: mocks.inspectReadiness,
}));
vi.mock("@/lib/agents/orchestrator", () => ({ orchestrate: mocks.orchestrate }));
vi.mock("@/lib/agents/llm", () => ({ runAgentLLM: mocks.agentLLM }));
vi.mock("@/lib/agents/tool-loop", () => ({
  runAgentWithTools: mocks.agentTools, getDefaultToolPreset: mocks.toolPreset,
}));
vi.mock("@/lib/security/secrets", () => ({
  getSecret: mocks.secret, getSecretWithFallback: mocks.secretFallback,
  getSecretReadiness: mocks.secretReadiness,
}));
vi.mock("@/lib/security/sandbox", () => ({
  runSandboxedCommand: mocks.sandboxRun, cancelSandboxOperation: mocks.sandboxCancel,
  getSandboxRuntimeSnapshot: mocks.sandboxSnapshot,
  SandboxViolationError: class extends Error {},
}));
vi.mock("@/lib/security/policy", () => ({
  evaluatePolicyGuard: mocks.policyGuard, getPolicyProfile: mocks.policyProfile,
  getPolicyRules: mocks.policyRules, setPolicyProfile: mocks.policySet,
}));
vi.mock("@/lib/security/approvals", () => ({
  listApprovals: mocks.approvalList, requestApproval: mocks.approvalRequest,
  decideApproval: mocks.approvalDecide,
}));
vi.mock("@/lib/security/audit", () => ({
  appendAuditEvent: mocks.auditAppend, getAuditEvents: mocks.auditRead,
}));
vi.mock("@/lib/projects/workspace", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/projects/workspace")>(),
  ensureProjectsRoot: mocks.projectsRoot, listProjectFiles: mocks.projectFiles,
  scanRecentProjects: mocks.projectRecent,
}));

import * as chat from "@/app/api/chat/main/route";
import * as deploy from "@/app/api/deploy/route";
import * as files from "@/app/api/files/route";
import * as githubApi from "@/app/api/github/api/route";
import * as githubOps from "@/app/api/github/ops/route";
import * as health from "@/app/api/health/slis/route";
import * as orchestrate from "@/app/api/orchestrate/route";
import * as orchestrateStream from "@/app/api/orchestrate/stream/route";
import * as projects from "@/app/api/projects/route";
import * as projectWorkspace from "@/app/api/projects/workspace/route";
import * as approvals from "@/app/api/security/approvals/route";
import * as audit from "@/app/api/security/audit/route";
import * as policy from "@/app/api/security/policy/route";
import * as readiness from "@/app/api/security/readiness/route";
import * as sandbox from "@/app/api/security/sandbox/route";
import * as workspaces from "@/app/api/workspaces/route";
import * as preview from "@/app/api/workspaces/[projectId]/preview/route";
import { hasMinRole, isVerifiedPrivateOwnerSession, resolveAuthSession, type AuthSession } from "@/lib/security/auth";
import { SessionStoreError, type OwnerSession } from "@/lib/security/session-store";
import { isWorkspaceOwner } from "@/lib/security/workspace-ownership";

const ORIGIN = "http://localhost:3000";
const TOKEN = Buffer.alloc(32, 11).toString("base64url");
const COOKIE = `cr8or-dev-session=${TOKEN}`;
const ownerSession: OwnerSession = {
  id: "server-issued-session-id",
  ownerId: "owner",
  credentialVersion: 4,
  authenticationMethod: "ACCESS_CODE",
  authenticatedAt: new Date("2030-01-01T00:00:00Z"),
  createdAt: new Date("2030-01-01T00:00:00Z"),
  expiresAt: new Date("2030-01-01T12:00:00Z"),
  revokedAt: null,
  lastActiveAt: null,
};

type RouteModule = Record<string, unknown>;
type Handler = (request: NextRequest, context: { params: Promise<{ projectId: string }> }) => Promise<Response>;
const routeDefinitions: Array<{ path: string; module: RouteModule; methods: string[] }> = [
  { path: "/api/chat/main", module: chat, methods: ["POST", "OPTIONS"] },
  { path: "/api/deploy", module: deploy, methods: ["POST", "OPTIONS"] },
  { path: "/api/files", module: files, methods: ["GET", "POST", "OPTIONS"] },
  { path: "/api/github/api", module: githubApi, methods: ["POST", "OPTIONS"] },
  { path: "/api/github/ops", module: githubOps, methods: ["POST", "OPTIONS"] },
  { path: "/api/health/slis", module: health, methods: ["GET", "OPTIONS"] },
  { path: "/api/orchestrate", module: orchestrate, methods: ["POST", "OPTIONS"] },
  { path: "/api/orchestrate/stream", module: orchestrateStream, methods: ["POST", "OPTIONS"] },
  { path: "/api/projects", module: projects, methods: ["GET", "POST", "OPTIONS"] },
  { path: "/api/projects/workspace", module: projectWorkspace, methods: ["POST", "OPTIONS"] },
  { path: "/api/security/approvals", module: approvals, methods: ["GET", "POST", "OPTIONS"] },
  { path: "/api/security/audit", module: audit, methods: ["GET", "OPTIONS"] },
  { path: "/api/security/policy", module: policy, methods: ["GET", "POST", "OPTIONS"] },
  { path: "/api/security/readiness", module: readiness, methods: ["GET", "OPTIONS"] },
  { path: "/api/security/sandbox", module: sandbox, methods: ["GET", "POST", "OPTIONS"] },
  { path: "/api/workspaces", module: workspaces, methods: ["GET", "POST", "OPTIONS"] },
  { path: "/api/workspaces/cloud-existing-project/preview", module: preview, methods: ["POST", "OPTIONS"] },
];

// Next.js delegates an implicit HEAD to GET, with request.method still HEAD.
const endpoints = routeDefinitions.flatMap((route) => [
  ...route.methods.map((method) => ({ ...route, method, exportName: method })),
  ...(route.methods.includes("GET") ? [{ ...route, method: "HEAD", exportName: "GET" }] : []),
]);

function request(path: string, method = "GET", headers: HeadersInit = {}, body = "{}") {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(!["GET", "HEAD", "OPTIONS"].includes(method) ? { body } : {}),
  });
}

function invoke(endpoint: typeof endpoints[number], req: NextRequest) {
  const handler = endpoint.module[endpoint.exportName] as Handler;
  expect(handler, `${endpoint.exportName} ${endpoint.path} is exported`).toBeTypeOf("function");
  return handler(req, { params: Promise.resolve({ projectId: "cloud-existing-project" }) });
}

function expectNoSensitiveWork() {
  for (const [name, spy] of Object.entries(mocks)) {
    if (["resolveOwnerSession", "auditAppend"].includes(name)) continue;
    expect(spy, `${name} must not run before authorization`).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "true");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", ORIGIN);
  vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", Buffer.alloc(32, 5).toString("base64url"));
  vi.stubEnv("CR8OR_FEATURE_AUTH_GUARD", "false");
  vi.stubEnv("CR8OR_DEV_API_TOKEN", "legacy-development-token");
  vi.stubEnv("CR8OR_DEV_USER_ID", "local-dev");
  vi.stubEnv("CR8OR_OWNER_IDS", "local-dev,attacker-claimed-owner");
  vi.stubEnv("CR8OR_WORKSPACE_OWNERS_JSON", '{"default":["attacker-claimed-owner"]}');
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.resolveOwnerSession.mockResolvedValue(null);
  mocks.projectFindMany.mockResolvedValue([{ id: "preserved-project", name: "Existing project" }]);
  mocks.projectCreate.mockResolvedValue({ id: "new-project", name: "Example" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const unauthenticatedInputs: Array<{ name: string; headers: HeadersInit }> = [
  { name: "missing cookie", headers: {} },
  { name: "forged opaque cookie", headers: { cookie: COOKIE } },
  { name: "malformed cookie", headers: { cookie: "cr8or-dev-session=owner" } },
  { name: "legacy developer bearer", headers: { authorization: "Bearer legacy-development-token" } },
  { name: "legacy developer header", headers: { "x-cr8or-token": "legacy-development-token" } },
  { name: "Supabase bearer", headers: { authorization: "Bearer supabase-owner-token" } },
  { name: "claimed owner and session", headers: {
    "x-owner-id": "owner", "x-user-id": "local-dev", "x-session-id": "server-issued-session-id",
    "x-role": "owner", "x-authenticated": "true",
  } },
];

const invalidMutationHeaders: Array<Record<string, string>> = [
  {},
  { origin: ORIGIN },
  { "x-cr8or-auth": "1" },
  { origin: "https://attacker.invalid", "x-cr8or-auth": "1" },
  { origin: ORIGIN, "x-cr8or-auth": "1", "sec-fetch-site": "cross-site" },
];

describe.each(endpoints)("private API boundary: $method $path", (endpoint) => {
  it.each(unauthenticatedInputs)("rejects $name before work or request parsing", async ({ headers }) => {
    const req = request(endpoint.path, endpoint.method, headers);
    const parse = vi.spyOn(req, "json");
    const response = await invoke(endpoint, req);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(parse).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });

  it("fails closed on unavailable session storage", async () => {
    mocks.resolveOwnerSession.mockRejectedValue(new SessionStoreError());
    const req = request(endpoint.path, endpoint.method, { cookie: COOKIE });
    const parse = vi.spyOn(req, "json");
    const response = await invoke(endpoint, req);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
    expect(parse).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });

  it("does not turn malformed activation into legacy access", async () => {
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "TRUE");
    const response = await invoke(endpoint, request(endpoint.path, endpoint.method));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolveOwnerSession).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });
});

describe("private route behavior with verified owner sessions", () => {
  beforeEach(() => {
    mocks.resolveOwnerSession.mockResolvedValue(ownerSession);
  });

  it("uses the cookie and database identity for a protected read, ignoring client identity claims", async () => {
    const response = await projects.GET(request("/api/projects?ownerId=attacker", "GET", {
      cookie: COOKIE, "x-owner-id": "attacker", "x-role": "viewer", authorization: "Bearer attacker",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual([{ id: "preserved-project", name: "Existing project" }]);
    expect(mocks.resolveOwnerSession).toHaveBeenCalledWith(TOKEN);
    expect(mocks.projectFindMany).toHaveBeenCalledOnce();
    expect(mocks.supabase).not.toHaveBeenCalled();
    expect(mocks.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "owner", actorRole: "owner", action: "route.access",
    }));
  });

  it("resolves the database again on subsequent requests", async () => {
    const first = await projects.GET(request("/api/projects", "GET", { cookie: COOKIE }));
    expect(first.status).toBe(200);
    mocks.resolveOwnerSession.mockResolvedValue(null);
    const second = await projects.GET(request("/api/projects", "GET", { cookie: COOKIE }));
    expect(second.status).toBe(401);
    expect(mocks.projectFindMany).toHaveBeenCalledOnce();
  });

  it("rejects duplicate session cookies before database access", async () => {
    const response = await projects.GET(request("/api/projects", "GET", {
      cookie: `${COOKIE}; ${COOKIE}`,
    }));
    expect(response.status).toBe(401);
    expect(mocks.resolveOwnerSession).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });

  it.each(invalidMutationHeaders)("rejects a mutation with invalid origin protection (case %#)", async (headers) => {
    const req = request("/api/projects", "POST", { cookie: COOKIE, ...headers }, '{"name":"Example"}');
    const parse = vi.spyOn(req, "json");
    const response = await projects.POST(req);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parse).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });

  it("allows an authenticated same-origin mutation", async () => {
    const response = await projects.POST(request("/api/projects", "POST", {
      cookie: COOKIE, origin: ORIGIN, "x-cr8or-auth": "1", "content-type": "application/json",
    }, '{"name":"Example"}'));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.projectCreate).toHaveBeenCalledWith({ data: {
      name: "Example", description: "", framework: "Next.js", language: "TypeScript",
    } });
  });

  it.each([
    { path: "/api/chat/main", handler: chat.POST },
    { path: "/api/orchestrate", handler: orchestrate.POST },
    { path: "/api/orchestrate/stream", handler: orchestrateStream.POST },
  ])("blocks incomplete agent execution even for the owner: $path", async ({ path, handler }) => {
    const req = request(path, "POST", {
      cookie: COOKIE, origin: ORIGIN, "x-cr8or-auth": "1", "content-type": "application/json",
    }, '{"prompt":"Run agent tools","message":"Run agent tools"}');
    const parse = vi.spyOn(req, "json");
    const response = await handler(req);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parse).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });
});

describe("coherent private authorization configuration", () => {
  it.each([
    { enabled: "true", origin: undefined, key: undefined },
    { enabled: "true", origin: ORIGIN, key: undefined },
    { enabled: "true", origin: "http://attacker.invalid", key: Buffer.alloc(32, 5).toString("base64url") },
    { enabled: "true", origin: ORIGIN, key: "malformed" },
    { enabled: "false", origin: ORIGIN, key: Buffer.alloc(32, 5).toString("base64url") },
    { enabled: undefined, origin: ORIGIN, key: undefined },
    { enabled: undefined, origin: undefined, key: Buffer.alloc(32, 5).toString("base64url") },
    { enabled: "", origin: undefined, key: undefined },
  ])("fails closed on missing, invalid, or partially disabled configuration (case %#)", async ({ enabled, origin, key }) => {
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", enabled);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", origin);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", key);
    mocks.resolveOwnerSession.mockResolvedValue(ownerSession);
    const response = await projects.GET(request("/api/projects", "GET", { cookie: COOKIE }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolveOwnerSession).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });

  it.each([undefined, "false"])("preserves the existing app only in explicit inactive configuration %s", async (enabled) => {
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", enabled);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", undefined);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", undefined);
    const response = await projects.GET(request("/api/projects"));
    expect(response.status).toBe(200);
    expect(mocks.projectFindMany).toHaveBeenCalledOnce();
    expect(mocks.resolveOwnerSession).not.toHaveBeenCalled();
  });
});

describe("trusted singleton-owner context", () => {
  it("retains the singleton identity and server provenance without exposing session records", async () => {
    mocks.resolveOwnerSession.mockResolvedValue(ownerSession);
    const session = await resolveAuthSession(request("/api/projects", "GET", { cookie: COOKIE }), false);
    expect(session).toEqual({ userId: "owner", role: "owner", provider: "private-session", authenticated: true });
    expect(Object.isFrozen(session)).toBe(true);
    expect(isVerifiedPrivateOwnerSession(session!)).toBe(true);
    expect(hasMinRole(session!, "owner")).toBe(true);
    expect(isWorkspaceOwner(session!, "existing-daytona-workspace-id")).toBe(true);
    expect(JSON.stringify(session)).not.toContain(TOKEN);
    expect(JSON.stringify(session)).not.toContain(ownerSession.id);

    // Client-supplied objects, JSON serialization, and spreading do not convey
    // proof that this request was authenticated by the database.
    for (const untrusted of [{ ...session! }, JSON.parse(JSON.stringify(session)) as AuthSession]) {
      expect(isVerifiedPrivateOwnerSession(untrusted)).toBe(false);
      expect(hasMinRole(untrusted, "viewer")).toBe(false);
      expect(isWorkspaceOwner(untrusted, "existing-daytona-workspace-id")).toBe(false);
    }
  });

  it.each(["disabled", "dev-token", "supabase", "private-session"] as const)(
    "does not authorize a constructed owner context with provider %s", (provider) => {
      const forged: AuthSession = { userId: "local-dev", role: "owner", provider, authenticated: true };
      expect(hasMinRole(forged, "viewer")).toBe(false);
      expect(isWorkspaceOwner(forged, "default")).toBe(false);
    },
  );

  it("rejects a non-singleton identity even if a session-store adapter returns it", async () => {
    mocks.resolveOwnerSession.mockResolvedValue({ ...ownerSession, ownerId: "attacker-claimed-owner" });
    const response = await projects.GET(request("/api/projects", "GET", { cookie: COOKIE }));
    expect(response.status).toBe(401);
    expectNoSensitiveWork();
  });

  it("does not disclose infrastructure errors or fall back to legacy tokens", async () => {
    mocks.resolveOwnerSession.mockRejectedValue(new Error("private database connection details"));
    const response = await projects.GET(request("/api/projects", "GET", {
      cookie: COOKIE, authorization: "Bearer legacy-development-token",
    }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database connection details");
    expectNoSensitiveWork();
  });
});
