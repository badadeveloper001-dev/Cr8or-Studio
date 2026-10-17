import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), revalidateSession: vi.fn(), prepare: vi.fn(), decide: vi.fn(), execute: vi.fn(), read: vi.fn(), reconcile: vi.fn(), inspect: vi.fn(),
  provider: vi.fn(), policy: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), runtime: vi.fn(), legacyRuntime: vi.fn(),
}));
vi.mock("@/lib/security/session-store", () => ({ resolveOwnerSession: mocks.session, resolveSessionById: mocks.revalidateSession }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseClient: vi.fn() }));
vi.mock("@/lib/workspace/private-workspace-lifecycle", () => ({
  prepareWorkspaceLifecycle: mocks.prepare, decideWorkspaceLifecycle: mocks.decide,
  executeWorkspaceLifecycle: mocks.execute, readWorkspaceLifecycle: mocks.read,
  reconcileWorkspaceLifecycle: mocks.reconcile, inspectWorkspaceLifecycle: mocks.inspect,
}));
vi.mock("@/lib/workspace/providers/daytona", () => ({ createDaytonaProvider: mocks.provider, DaytonaProvider: class { constructor() { mocks.provider(); } } }));
vi.mock("@/lib/security/policy", () => ({ evaluatePolicyGuard: mocks.policy }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { workspace: { findFirst: mocks.findFirst, findMany: mocks.findMany } } }));
vi.mock("@/lib/workspace/authorized-runtime", () => ({ authorizedRuntime: mocks.runtime }));
vi.mock("@/lib/workspace/runtime-factory", () => ({ getWorkspaceRuntime: mocks.legacyRuntime }));

import { POST, OPTIONS } from "@/app/api/workspaces/lifecycle/route";
import { POST as create, GET as list } from "@/app/api/workspaces/route";
import { POST as projectWorkspace } from "@/app/api/projects/workspace/route";
import { PRIVATE_LIFECYCLE_BODY_LIMITS } from "@/lib/security/private-lifecycle-http";

const origin = "https://studio.example.test";
const token = Buffer.alloc(32, 17).toString("base64url");
const id = "f6ee8158-6d42-4db8-a018-b297535e33f6";
const operation = { action: "create", idempotencyKey: id, projectName: "Isolated project" };
const session = { id: "server-only-session", ownerId: "owner", credentialVersion: 1, expiresAt: new Date(Date.now() + 60_000) };

function request(body: unknown, headers: HeadersInit = {}, path = "/api/workspaces/lifecycle", signal?: AbortSignal) {
  return rawRequest(JSON.stringify(body), headers, path, signal);
}
function rawRequest(body: BodyInit | null, overrides: HeadersInit = {}, path = "/api/workspaces/lifecycle", signal?: AbortSignal) {
  const headers = new Headers({ origin, "x-cr8or-auth": "1", "content-type": "application/json", cookie: `__Host-cr8or-session=${token}` });
  new Headers(overrides).forEach((value, key) => headers.set(key, value));
  return new NextRequest(`${origin}${path}`, { method: "POST", headers, body, signal, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
}
function expectNoSensitiveWork() {
  for (const mock of [mocks.prepare, mocks.decide, mocks.execute, mocks.read, mocks.reconcile, mocks.inspect, mocks.provider, mocks.policy]) {
    expect(mock).not.toHaveBeenCalled();
  }
}
function inactive() {
  for (const key of ["CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY"]) vi.stubEnv(key, undefined);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "true");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", origin);
  vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", Buffer.alloc(32, 18).toString("base64url"));
  vi.stubEnv("CR8OR_FEATURE_AUTH_GUARD", "false");
  vi.stubEnv("CR8OR_FEATURE_AUDIT_LOG", "false");
  vi.stubEnv("CR8OR_WORKSPACE_MODE", "cloud");
  vi.stubEnv("DAYTONA_API_KEY", undefined);
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) vi.stubEnv(key, undefined);
  mocks.session.mockResolvedValue(session);
  mocks.revalidateSession.mockResolvedValue(session);
  mocks.prepare.mockResolvedValue({ id, status: "PENDING", preview: { action: "create", projectName: operation.projectName } });
  mocks.decide.mockResolvedValue({ id, status: "APPROVED" });
  mocks.read.mockResolvedValue({ id, status: "UNKNOWN" });
  mocks.findMany.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("private lifecycle HTTP boundary", () => {
  it("authenticates before bounded parsing or preparing a structured approval", async () => {
    const input = request({ action: "prepare", request: operation });
    const parse = vi.spyOn(input, "json");
    const response = await POST(input);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parse).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: "owner", provider: "private-session" }), operation, input.signal);
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it.each(["", "__Host-cr8or-session=forged"])("rejects missing or forged owner sessions before reading a body (%s)", async cookie => {
    if (cookie) mocks.session.mockResolvedValue(null);
    const input = rawRequest("not-json", { cookie });
    const bodyRead = vi.spyOn(input.body!, "getReader");
    const response = await POST(input);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bodyRead).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });

  it.each<HeadersInit>([
    { origin: "https://unrelated.example.test" }, { origin: "" }, { "x-cr8or-auth": "" }, { "sec-fetch-site": "cross-site" },
  ])("rejects incorrect request-origin protection before parsing: %j", async headers => {
    const input = rawRequest("not-json", headers);
    const bodyRead = vi.spyOn(input.body!, "getReader");
    expect((await POST(input)).status).toBe(400);
    expect(bodyRead).not.toHaveBeenCalled();
    expectNoSensitiveWork();
  });

  it.each<HeadersInit>([
    { "content-type": "text/plain" }, { "content-type": "application/json; charset=latin1" }, { "content-encoding": "gzip" },
    { "content-length": "-1" }, { "content-length": "not-a-number" }, { "content-length": "2" },
  ])("rejects invalid request framing: %j", async headers => {
    expect((await POST(request({ action: "prepare", request: operation }, headers))).status).toBe(400);
    expectNoSensitiveWork();
  });

  it.each([
    null, [], {}, { action: "delete", projectId: "x" }, { action: "prepare", request: operation, ownerId: "owner" },
    { action: "prepare", request: { ...operation, providerWorkspaceId: "attacker-workspace" } },
    { action: "prepare", request: { ...operation, projectId: "attacker-project" } },
    { action: "prepare", request: { ...operation, projectName: "" } },
    { action: "prepare", request: { action: "clone", idempotencyKey: id, repositoryUrl: "https://secret@github.com/owner/repo", branch: "main" } },
    { action: "decide", approvalId: id, decision: "approve", scope: { ownerId: "owner" } },
    { action: "status", operationId: "not-a-uuid" },
    { action: "open", projectId: "registered", providerWorkspaceId: "substitution" },
  ])("rejects malformed or client-authored scope fields: %j", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expectNoSensitiveWork();
  });

  it.each(["{", '{"action":"prepare","request":"secret-content"}'])("sanitizes malformed JSON and operation errors", async text => {
    const response = await POST(rawRequest(text));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("secret-content");
    expectNoSensitiveWork();
  });

  it.each([true, false])("rejects oversized body, declared=%s", async declared => {
    const body = " ".repeat(PRIVATE_LIFECYCLE_BODY_LIMITS.bytes + 1);
    const response = await POST(rawRequest(body, declared ? { "content-length": String(body.length) } : {}));
    expect(response.status).toBe(413);
    expectNoSensitiveWork();
  });

  it("bounds an interrupted body and cancels its stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('{"action":')); }, cancel });
    const pending = POST(rawRequest(stream));
    await vi.advanceTimersByTimeAsync(PRIVATE_LIFECYCLE_BODY_LIMITS.timeoutMs + 1);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expectNoSensitiveWork();
  });

  it("rejects aborted requests without preparing approval", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await POST(request({ action: "prepare", request: operation }, {}, undefined, controller.signal))).status).toBe(400);
    expectNoSensitiveWork();
  });

  it("decides only by server approval ID and authenticated session", async () => {
    const response = await POST(request({ action: "decide", approvalId: id, decision: "approve" }));
    expect(response.status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "private-session" }), id, "approve");
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("reports durable UNKNOWN state without attempting provider recovery", async () => {
    const response = await POST(request({ action: "status", operationId: id }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, operation: { id, status: "UNKNOWN" } });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "private-session" }), id);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it.each([
    { action: "execute", request: operation }, { action: "execute", request: operation, approvalId: id },
    { action: "execute", request: { action: "start", idempotencyKey: id, projectId: "registered" } },
    { action: "execute", request: { action: "stop", idempotencyKey: id, projectId: "registered" } },
    { action: "reconcile", operationId: id }, { action: "open", projectId: "registered" }, { action: "state", projectId: "registered" },
  ])("preserves hardcoded release restriction before any provider workflow: %j", async body => {
    vi.stubEnv("CR8OR_WORKSPACE_LIFECYCLE_ENABLED", "true");
    const response = await POST(request(body));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectNoSensitiveWork();
  });

  it.each(["prepare", "decide", "status"])("sanitizes infrastructure errors in %s", async action => {
    const error = new Error("secret-token database-url private-provider-details");
    mocks.prepare.mockRejectedValue(error); mocks.decide.mockRejectedValue(error); mocks.read.mockRejectedValue(error);
    const body = action === "prepare" ? { action, request: operation } : action === "decide" ? { action, approvalId: id, decision: "approve" } : { action, operationId: id };
    const response = await POST(request(body));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toMatch(/secret-token|database-url|private-provider-details/);
  });

  it("does not authorize when the authentication database is unavailable", async () => {
    mocks.session.mockRejectedValue(new Error("secret database failure"));
    expect((await POST(request({ action: "prepare", request: operation }))).status).toBe(503);
    expectNoSensitiveWork();
  });

  it("remains disabled with absent configuration instead of authorizing a synthetic owner", async () => {
    inactive();
    expect((await POST(request({ action: "prepare", request: operation }))).status).toBe(503);
    expectNoSensitiveWork();
  });

  it("fails closed for partial authentication configuration", async () => {
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "false");
    expect((await POST(request({ action: "prepare", request: operation }))).status).toBe(503);
    expectNoSensitiveWork();
  });

  it("protects explicit OPTIONS and supplies no wildcard CORS", async () => {
    const response = await OPTIONS(new NextRequest(`${origin}/api/workspaces/lifecycle`, { method: "OPTIONS", headers: { cookie: `__Host-cr8or-session=${token}` } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("OPTIONS, POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    inactive();
    expect((await OPTIONS(new NextRequest(`${origin}/api/workspaces/lifecycle`, { method: "OPTIONS" }))).status).toBe(503);
  });
});

describe("existing workspace routes preserve private lifecycle separation", () => {
  it("blocks legacy cloud creation before parsing, API-key checks, policy or provider calls", async () => {
    const input = rawRequest("not-json", {}, "/api/workspaces");
    const parse = vi.spyOn(input, "json");
    const response = await create(input);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parse).not.toHaveBeenCalled();
    expectNoSensitiveWork();
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it.each([{ action: "create", name: "Isolated project" }, { action: "clone", repositoryUrl: "https://github.com/example/project" }])("blocks private legacy $action before generic approval or credential access", async body => {
    expect((await projectWorkspace(request(body, {}, "/api/projects/workspace"))).status).toBe(503);
    expectNoSensitiveWork();
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("lists registered state without starting, creating or recovering a sandbox", async () => {
    const response = await list(new NextRequest(`${origin}/api/workspaces`, { headers: { cookie: `__Host-cr8or-session=${token}` } }));
    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledOnce();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.legacyRuntime).not.toHaveBeenCalled();
  });

  it("preserves registered identity and refuses unsafe open recovery", async () => {
    mocks.findFirst.mockResolvedValue({ projectId: "historical-project", providerWorkspaceId: "historical-sandbox", projectName: "Historical", repositoryUrl: "https://github.com/example/project", updatedAt: new Date() });
    mocks.runtime.mockResolvedValue({ ok: false, response: Response.json({ ok: false }, { status: 503 }) });
    expect((await projectWorkspace(request({ action: "open", path: "historical-project" }, {}, "/api/projects/workspace"))).status).toBe(503);
    expect(mocks.runtime).toHaveBeenCalledWith(expect.any(NextRequest), "historical-project");
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.legacyRuntime).not.toHaveBeenCalled();
  });

  it("rejects arbitrary workspace IDs injected into the private existing open contract", async () => {
    expect((await projectWorkspace(request({ action: "open", path: "historical-project", sandboxId: "unrelated" }, {}, "/api/projects/workspace"))).status).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("preserves deliberately inactive legacy policy behavior", async () => {
    inactive();
    vi.stubEnv("DAYTONA_API_KEY", "synthetic-test-key");
    mocks.policy.mockReturnValue({ allowed: false, reason: "Approval required", approvalRequired: true, profile: "balanced", risk: "high" });
    const response = await create(request({ projectName: "Inactive project" }, {}, "/api/workspaces"));
    expect(response.status).toBe(409);
    expect(mocks.policy).toHaveBeenCalledOnce();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
