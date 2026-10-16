import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ check: vi.fn(), generate: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/security/execution-context", () => ({
  ExecutionAuthorizationError: class extends Error { constructor(readonly status: number, message = "Authentication required.") { super(message); } },
  revalidateExecutionAuthorization: mocks.check,
}));
vi.mock("ai", () => ({ generateText: mocks.generate }));
vi.mock("@/lib/security/secrets", () => ({ getSecret: () => "synthetic-provider-key-for-test" }));

import { ExecutionAuthorizationError, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { runAgentLLM } from "@/lib/agents/llm";

let authorization: ExecutionAuthorizationContext;
let active: boolean;
let controller: AbortController;
const options = () => ({ authorization, projectId: "registered" });
beforeEach(() => {
  vi.resetAllMocks();
  active = true;
  controller = new AbortController();
  authorization = { projectId: "registered", signal: controller.signal } as ExecutionAuthorizationContext;
  mocks.check.mockImplementation(async (context, projectId) => {
    if (context !== authorization || projectId !== "registered" || !active || controller.signal.aborted) {
      controller.abort();
      throw new ExecutionAuthorizationError(401);
    }
  });
  mocks.generate.mockResolvedValue({ text: "Authorized response" });
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("model authorization and cancellation", () => {
  it("rejects missing context before contacting a provider", async () => {
    await expect(runAgentLLM("system", "prompt", { provider: "openai" })).rejects.toThrow("Authentication required");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("passes only an abort signal to the SDK and suppresses unauthorized output", async () => {
    mocks.generate.mockImplementation(async () => { active = false; return { text: "sensitive response" }; });
    await expect(runAgentLLM("system", "prompt", { provider: "openai" }, [], options())).rejects.toThrow("Authentication required");
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({ abortSignal: controller.signal, maxRetries: 0 });
    expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty("authorization");
    expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty("sessionId");
  });

  it("revalidates before a retry instead of issuing another provider request", async () => {
    mocks.generate.mockImplementation(async () => { active = false; throw new Error("temporary provider failure"); });
    await expect(runAgentLLM("system", "prompt", { provider: "openai" }, [], options())).rejects.toThrow("Authentication required");
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it("does not send a fallback vision request after revocation", async () => {
    mocks.fetch.mockImplementation(async () => {
      active = false;
      return new Response(JSON.stringify({ error: "unsupported image request" }), { status: 400 });
    });
    await expect(runAgentLLM("system", "prompt", { provider: "deepseek" }, [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" }], options())).rejects.toThrow("Authentication required");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("does not report a cancelled external request as a successful fallback", async () => {
    mocks.fetch.mockImplementation(async () => { controller.abort(); throw new Error("aborted"); });
    await expect(runAgentLLM("system", "prompt", { provider: "openai" }, [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" }], options())).rejects.toThrow("Authentication required");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
