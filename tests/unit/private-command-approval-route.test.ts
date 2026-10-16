import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), context: vi.fn(), create: vi.fn(), decide: vi.fn(), list: vi.fn(),
  legacyRequest: vi.fn(), legacyDecide: vi.fn(), legacyList: vi.fn(), mode: vi.fn(),
}));
vi.mock("@/lib/security/authorization", () => ({ authorizeRoute: mocks.authorize }));
vi.mock("@/lib/security/private-auth-mode", () => ({ getPrivateAuthMode: mocks.mode }));
vi.mock("@/lib/security/command-approvals", () => ({
  createPrivateCommandApproval: mocks.create,
  decidePrivateCommandApproval: mocks.decide,
  listPrivateCommandApprovals: mocks.list,
}));
vi.mock("@/lib/security/approvals", () => ({
  requestApproval: mocks.legacyRequest, decideApproval: mocks.legacyDecide, listApprovals: mocks.legacyList,
}));
vi.mock("@/lib/security/execution-context", () => ({
  createExecutionAuthorization: mocks.context,
  ExecutionAuthorizationError: class extends Error {
    constructor(readonly status: number, message = "Approval operation is not authorized.") { super(message); }
  },
}));

import { GET, POST } from "@/app/api/security/approvals/route";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";

const session = Object.freeze({ userId: "owner", role: "owner", provider: "private-session", authenticated: true });
const context = Object.freeze({ ownerId: "owner", projectId: "project-a", workspace: { providerWorkspaceId: "sandbox-a" } });
const approval = Object.freeze({
  id: "040d4c78-d767-4199-a662-15db78c138d9", action: "commands.execute",
  title: "Run npm run lint", preview: "Project: project-a\nDaytona workspace: sandbox-a\nCommand: npm run lint",
  requestedAt: "2026-10-17T11:00:00.000Z", status: "pending",
});
const createBody = { intent: "request", payload: { action: "commands.execute", projectId: "project-a", commandKey: "npm run lint" } };
const legacy = { ...approval, id: "45326e71-8efa-4c59-ac67-069de73b5bb5", action: "files.write", requestedAt: "2026-10-17T10:00:00.000Z" };

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://studio.example.test/api/security/approvals", {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: "https://studio.example.test", "x-cr8or-auth": "1", ...headers },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode.mockReturnValue("required");
  mocks.authorize.mockResolvedValue({ ok: true, session });
  mocks.context.mockResolvedValue(context);
  mocks.create.mockResolvedValue(approval);
  mocks.decide.mockResolvedValue({ ...approval, status: "approved" });
  mocks.list.mockResolvedValue([approval]);
  mocks.legacyList.mockReturnValue([]);
  mocks.legacyRequest.mockReturnValue(legacy);
  mocks.legacyDecide.mockReturnValue({ ...legacy, status: "approved" });
});

describe("private scoped command approval route", () => {
  it("resolves the registered project from the authenticated owner and returns the server-generated preview", async () => {
    const response = await POST(request(createBody));
    expect(response.status).toBe(201);
    expect(mocks.context).toHaveBeenCalledExactlyOnceWith(session, "project-a", expect.objectContaining({ permissions: ["command"] }));
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(context, "npm run lint");
    expect(await response.json()).toEqual({ ok: true, approval });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.legacyRequest).not.toHaveBeenCalled();
  });

  it.each(["ownerId", "sessionId", "credentialVersion", "workspaceId", "providerWorkspaceId", "title", "preview", "scope", "approved"])(
    "rejects client-supplied %s rather than treating it as trusted scope", async field => {
      const response = await POST(request({ ...createBody, payload: { ...createBody.payload, [field]: "forged" } }));
      expect(response.status).toBe(400);
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it("rejects scope claims on the outer envelope", async () => {
    expect((await POST(request({ ...createBody, ownerId: "owner" }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["npm test && cat .env", "npm run lint -- --fix", "npm run unsupported"])("rejects unknown command %s before scope resolution", async commandKey => {
    expect((await POST(request({ ...createBody, payload: { ...createBody.payload, commandKey } }))).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("rejects an action-only legacy command approval request", async () => {
    const response = await POST(request({ intent: "request", payload: { action: "commands.execute", title: "Trust this title", preview: "npm run lint" } }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.legacyRequest).not.toHaveBeenCalled();
  });

  it("denies unauthenticated requests before parsing or creating approvals", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(request(createBody))).status).toBe(401);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 503] as const)("preserves the %s authorization failure before creating an approval", async status => {
    mocks.context.mockRejectedValue(new ExecutionAuthorizationError(status));
    expect((await POST(request(createBody))).status).toBe(status);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a missing trusted capability", async () => {
    mocks.context.mockResolvedValue(undefined);
    expect((await POST(request(createBody))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["approved", "denied", "revoked"])("decides a durable approval as %s using only the authenticated session", async decision => {
    const response = await POST(request({ intent: "decide", payload: { id: approval.id, decision } }));
    expect(response.status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(session, approval.id, decision);
    expect(mocks.legacyDecide).not.toHaveBeenCalled();
  });

  it("rejects forged decision scope fields", async () => {
    expect((await POST(request({ intent: "decide", payload: { id: approval.id, decision: "approved", commandKey: "npm test" } }))).status).toBe(400);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("rejects a legacy generic command decision without fallback", async () => {
    mocks.decide.mockResolvedValue(null);
    mocks.legacyList.mockReturnValue([approval]);
    expect((await POST(request({ intent: "decide", payload: { id: approval.id, decision: "approved" } }))).status).toBe(404);
    expect(mocks.legacyDecide).not.toHaveBeenCalled();
  });

  it("preserves decisions for unrelated legacy workflows when the durable ID is absent", async () => {
    mocks.decide.mockResolvedValue(null);
    mocks.legacyList.mockReturnValue([legacy]);
    expect((await POST(request({ intent: "decide", payload: { id: legacy.id, decision: "approved", reason: "Reviewed" } }))).status).toBe(200);
    expect(mocks.legacyDecide).toHaveBeenCalledExactlyOnceWith({ id: legacy.id, decision: "approved", reason: "Reviewed", decidedBy: "owner", decidedRole: "owner" });
  });

  it("does not reinterpret a revoke decision for an unrelated legacy approval", async () => {
    mocks.decide.mockResolvedValue(null);
    mocks.legacyList.mockReturnValue([legacy]);
    expect((await POST(request({ intent: "decide", payload: { id: legacy.id, decision: "revoked" } }))).status).toBe(400);
    expect(mocks.legacyDecide).not.toHaveBeenCalled();
  });

  it.each([401, 409, 503] as const)("never falls back to legacy approvals after a durable %s failure", async status => {
    mocks.decide.mockRejectedValue(new ExecutionAuthorizationError(status));
    mocks.legacyList.mockReturnValue([legacy]);
    expect((await POST(request({ intent: "decide", payload: { id: legacy.id, decision: "approved" } }))).status).toBe(status);
    expect(mocks.legacyList).not.toHaveBeenCalled();
    expect(mocks.legacyDecide).not.toHaveBeenCalled();
  });

  it("sanitizes an unexpected database failure and fails closed", async () => {
    mocks.create.mockRejectedValue(new Error("postgres://secret-user:secret-pass@private-host approval content"));
    const response = await POST(request(createBody));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/secret-pass|private-host|approval content/);
  });

  it("lists durable and unrelated legacy approvals while hiding old generic command approvals", async () => {
    mocks.legacyList.mockReturnValue([legacy, { ...approval, id: "legacy-command" }]);
    const response = await GET(new NextRequest("https://studio.example.test/api/security/approvals"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, approvals: [approval, legacy] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("denies approval listing on database failure instead of returning legacy-only data", async () => {
    mocks.list.mockRejectedValue(new ExecutionAuthorizationError(503));
    const response = await GET(new NextRequest("https://studio.example.test/api/security/approvals"));
    expect(response.status).toBe(503);
    expect(mocks.legacyList).not.toHaveBeenCalled();
  });

  it("preserves unrelated private approval request workflows", async () => {
    const response = await POST(request({ intent: "request", payload: { action: "files.write", title: "Write file", preview: "Reviewed file changes" } }));
    expect(response.status).toBe(201);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.legacyRequest).toHaveBeenCalledExactlyOnceWith({ action: "files.write", title: "Write file", preview: "Reviewed file changes", requestedBy: "owner", requestedRole: "owner" });
  });

  it("preserves inactive action-only approval behavior", async () => {
    mocks.mode.mockReturnValue("inactive");
    const response = await POST(request({ intent: "request", payload: { action: "commands.execute", title: "Run command", preview: "npm run lint" } }));
    expect(response.status).toBe(201);
    expect(mocks.legacyRequest).toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { "Content-Type": "text/plain" },
    { "Content-Encoding": "gzip" },
    { "Content-Length": "invalid" },
    { "Content-Length": "1" },
  ])("rejects malformed request transport %j", async headers => {
    expect((await POST(request(createBody, headers))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects oversized declared and actual request bodies", async () => {
    expect((await POST(request(createBody, { "Content-Length": "16385" }))).status).toBe(413);
    expect((await POST(request({ ...createBody, padding: "x".repeat(16385) }))).status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without reflecting submitted contents", async () => {
    const response = await POST(new NextRequest("https://studio.example.test/api/security/approvals", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{private request contents",
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private request contents");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
