import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), create: vi.fn(), revalidate: vi.fn(), cancel: vi.fn(),
  runtime: vi.fn(), config: vi.fn(), read: vi.fn(), list: vi.fn(),
  orchestrate: vi.fn(), classify: vi.fn(), model: vi.fn(), tools: vi.fn(),
}));
vi.mock("@/lib/security/authorization", () => ({ authorizeRoute: mocks.authorize }));
vi.mock("@/lib/security/private-auth-mode", () => ({ getPrivateAuthMode: () => "required" }));
vi.mock("@/lib/security/execution-context", () => ({
  createExecutionAuthorization: mocks.create,
  revalidateExecutionAuthorization: mocks.revalidate,
  cancelExecutionAuthorization: mocks.cancel,
  ExecutionAuthorizationError: class extends Error {
    constructor(readonly status: number) { super("Execution is not authorized."); }
  },
}));
vi.mock("@/lib/workspace/runtime-factory", () => ({ getWorkspaceRuntime: mocks.runtime, getWorkspaceConfig: mocks.config }));
vi.mock("@/lib/agents/orchestrator", () => ({ orchestrate: mocks.orchestrate }));
vi.mock("@/lib/intent", () => ({ classifyIntent: mocks.classify }));
vi.mock("@/lib/agents/llm", () => ({ runAgentLLM: mocks.model }));
vi.mock("@/lib/agents/tool-loop", () => ({ runAgentWithTools: mocks.tools, getDefaultToolPreset: () => ["read_file"] }));
vi.mock("@/lib/security/secrets", () => ({ getSecretReadiness: () => ({ checks: {} }) }));

import { POST as chat } from "@/app/api/chat/main/route";
import { POST as orchestrate } from "@/app/api/orchestrate/route";
import { POST as stream } from "@/app/api/orchestrate/stream/route";
import { ExecutionAuthorizationError, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { performLocalReadinessCheck, performReadOnlyTaskLoop } from "@/lib/workspace/workspace-inspection";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime";

const session = Object.freeze({ userId: "owner", role: "owner", provider: "private-session", authenticated: true });
let authorization: ExecutionAuthorizationContext;
let controller: AbortController;
let revoked: boolean;
const routes = [
  ["chat", chat, { projectId: "registered-project", message: "Read package.json" }],
  ["orchestrate", orchestrate, { projectId: "registered-project", prompt: "Inspect the project" }],
  ["stream", stream, { projectId: "registered-project", prompt: "Inspect the project" }],
] as const;

function request(body: unknown, signal?: AbortSignal) {
  return new NextRequest("https://studio.example.test/api/chat/main", {
    method: "POST", body: JSON.stringify(body), signal,
    headers: { "Content-Type": "application/json", Origin: "https://studio.example.test", "x-cr8or-auth": "1" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  controller = new AbortController();
  revoked = false;
  authorization = Object.freeze({ ownerId: "owner", projectId: "registered-project", workspace: { runtimeType: "local" }, permissions: ["read", "model"], signal: controller.signal }) as unknown as ExecutionAuthorizationContext;
  mocks.authorize.mockResolvedValue({ ok: true, session });
  mocks.create.mockImplementation(async (_session, projectId, options) => {
    if (projectId !== "registered-project") throw new ExecutionAuthorizationError(404);
    if (options.signal.aborted) throw new ExecutionAuthorizationError(401);
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    return authorization;
  });
  mocks.revalidate.mockImplementation(async (context, projectId) => {
    if (revoked || controller.signal.aborted) throw new ExecutionAuthorizationError(401);
    if (context !== authorization || projectId !== "registered-project") throw new ExecutionAuthorizationError(403);
  });
  mocks.cancel.mockImplementation(context => { if (context === authorization) controller.abort(); });
  mocks.runtime.mockResolvedValue({ readFile: mocks.read, listFiles: mocks.list });
  mocks.read.mockResolvedValue({ content: "authorized content" });
  mocks.list.mockResolvedValue([{ name: "package.json", type: "file" }]);
  mocks.classify.mockResolvedValue({ shouldDelegate: false, allowedToolMode: "none", intent: "conversation", requiresExplicitApproval: false });
  mocks.model.mockResolvedValue("Response:\nAuthorized reply.");
  mocks.tools.mockResolvedValue({ output: "Response:\nInspected workspace." });
  mocks.orchestrate.mockResolvedValue({ status: "completed" });
});

describe("trusted execution route propagation", () => {
  it.each(routes)("rejects missing owner authentication before %s work", async (_name, route, payload) => {
    mocks.authorize.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await route(request(payload))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.orchestrate).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it.each(routes)("rejects unknown projects before %s provider or runtime work", async (_name, route, payload) => {
    expect((await route(request({ ...payload, projectId: "unknown-project" }))).status).toBe(404);
    expect(mocks.orchestrate).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("requires a selected project for private main chat", async () => {
    expect((await chat(request({ message: "hello" }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it("scopes direct main-chat file reads to the authorized runtime", async () => {
    const response = await chat(request(routes[0][2]));
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(session, "registered-project", expect.objectContaining({ permissions: ["read", "model"] }));
    expect(mocks.runtime).toHaveBeenCalledExactlyOnceWith("registered-project", authorization);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith("package.json");
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("withholds a direct read result if the session is revoked during the read", async () => {
    mocks.read.mockImplementation(async () => { revoked = true; return { content: "private-file-content" }; });
    const response = await chat(request(routes[0][2]));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("private-file-content");
    expect(mocks.cancel).toHaveBeenCalledWith(authorization);
  });

  it("does not downgrade runtime authorization failures into conversational success", async () => {
    mocks.runtime.mockRejectedValue(new ExecutionAuthorizationError(403));
    const response = await chat(request(routes[0][2]));
    expect(response.status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("passes the owner capability separately from the main-chat agent identity", async () => {
    mocks.classify.mockResolvedValue({ shouldDelegate: false, allowedToolMode: "read-only", intent: "explanation" });
    const response = await chat(request({ projectId: "registered-project", message: "Explain the architecture" }));
    expect(response.status).toBe(200);
    expect(mocks.tools).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ authorization, projectId: "registered-project", actorId: "main-chat", actorRole: "assistant" }),
    }));
    expect(mocks.config).not.toHaveBeenCalled();
  });

  it("withholds model results after session expiration and passes the trusted context", async () => {
    mocks.model.mockImplementation(async () => { revoked = true; return "private-model-output"; });
    const response = await chat(request({ projectId: "registered-project", message: "Hello" }));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("private-model-output");
    expect(mocks.model.mock.calls[0][4]).toEqual({ authorization, projectId: "registered-project" });
  });

  it("propagates the capability into orchestration and revalidates before returning results", async () => {
    mocks.orchestrate.mockImplementation(async () => { revoked = true; return { data: "private-orchestration-output" }; });
    const response = await orchestrate(request(routes[1][2]));
    expect(mocks.orchestrate).toHaveBeenCalledWith(routes[1][2], undefined, authorization);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("private-orchestration-output");
  });

  it("revalidates every stream emission and stops progress after revocation", async () => {
    mocks.orchestrate.mockImplementation(async (_payload, emit) => {
      await emit({ type: "batch_complete", batchIndex: 0, total: 2 });
      revoked = true;
      await emit({ type: "done", result: { secret: "private-result-after-revocation" } });
    });
    const response = await stream(request(routes[2][2]));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"type":"batch_complete"');
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain("private-result-after-revocation");
    expect(body).not.toContain('"type":"done"');
    expect(controller.signal.aborted).toBe(true);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("aborts pending execution when the streaming consumer disconnects", async () => {
    let stopped = false;
    mocks.orchestrate.mockImplementation(async (_payload, _emit, context) => {
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
    });
    const response = await stream(request(routes[2][2]));
    await response.body!.cancel();
    expect(controller.signal.aborted).toBe(true);
    expect(stopped).toBe(true);
  });

  it.each(routes)("rejects already cancelled %s requests before execution", async (_name, route, payload) => {
    const cancellation = new AbortController();
    cancellation.abort();
    expect((await route(request(payload, cancellation.signal))).status).toBe(401);
    expect(mocks.orchestrate).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });
});

describe("direct inspection authorization failures", () => {
  it.each([performLocalReadinessCheck, performReadOnlyTaskLoop])("stops inspection after authorization is lost", async inspect => {
    const readFile = vi.fn().mockRejectedValue(new ExecutionAuthorizationError(401));
    const listFiles = vi.fn().mockResolvedValue([{ name: "package.json", type: "file" }]);
    await expect(inspect({ readFile, listFiles } as unknown as WorkspaceRuntime)).rejects.toBeInstanceOf(ExecutionAuthorizationError);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(listFiles).toHaveBeenCalledTimes(1);
  });
});
