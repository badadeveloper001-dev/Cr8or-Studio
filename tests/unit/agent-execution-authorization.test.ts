import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(), generate: vi.fn(), runtime: vi.fn(), read: vi.fn(), write: vi.fn(),
  policy: vi.fn(), appendMemory: vi.fn(), localNote: vi.fn(),
}));
vi.mock("@/lib/security/execution-context", () => ({
  ExecutionAuthorizationError: class extends Error { constructor(readonly status: number, message = "Authentication required.") { super(message); } },
  revalidateExecutionAuthorization: mocks.check,
}));
vi.mock("ai", () => ({ generateText: mocks.generate, dynamicTool: (x: unknown) => x, zodSchema: (x: unknown) => x }));
vi.mock("@/lib/agents/llm", () => ({ getDefaultLLMConfig: () => ({}), getModelForTools: () => ({}), runAgentLLM: vi.fn() }));
vi.mock("@/lib/security/policy", () => ({ evaluatePolicyGuard: mocks.policy }));
vi.mock("@/lib/security/audit", () => ({ appendAuditEvent: vi.fn() }));
vi.mock("@/lib/workspace/runtime-factory", () => ({ getWorkspaceRuntime: mocks.runtime }));
vi.mock("@/lib/agents/memory", () => ({
  appendGlobalMemory: mocks.appendMemory,
  getGlobalMemory: () => ({ goals: [], architecture: [], codingStandards: [] }),
  getLocalMemory: () => ({ notes: [] }), writeLocalNote: mocks.localNote,
}));

import { ExecutionAuthorizationError, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { executeTool } from "@/lib/agents/tool-executor";
import { runAgentWithTools, getAgentToolPreset } from "@/lib/agents/tool-loop";
import { executeTask, buildInitialDashboard } from "@/lib/agents/executor";
import { orchestrate } from "@/lib/agents/orchestrator";
import type { ToolContext } from "@/lib/agents/tools";

let controller: AbortController;
let authorization: ExecutionAuthorizationContext;
let active: boolean;
const task = { id: "task", agentId: "frontend" as const, title: "Inspection", input: "Inspect code", dependsOn: [], status: "pending" as const };
const toolContext = (actorId = "frontend"): ToolContext => Object.freeze({
  projectId: "registered", workspaceRoot: "/not-an-authority", requestId: "request", actorId,
  actorRole: "agent", authorization,
});
const input = () => ({ systemPrompt: "Inspect", userMessage: "Inspect code", agentId: "frontend", toolNames: getAgentToolPreset("frontend"), context: toolContext(), task });

beforeEach(() => {
  vi.resetAllMocks();
  active = true;
  controller = new AbortController();
  // The shared boundary is mocked here to test sequencing; DB-backed capability
  // provenance and session validity are covered by the execution integration suite.
  authorization = Object.freeze({ projectId: "registered", signal: controller.signal }) as ExecutionAuthorizationContext;
  mocks.check.mockImplementation(async (candidate, projectId) => {
    if (!active || candidate !== authorization || projectId !== "registered" || controller.signal.aborted) {
      controller.abort();
      throw new ExecutionAuthorizationError(401);
    }
  });
  mocks.runtime.mockResolvedValue({ readFile: mocks.read, writeFile: mocks.write });
  mocks.policy.mockReturnValue({ allowed: true, approvalRequired: false });
  mocks.read.mockResolvedValue({ content: "workspace evidence", bytes: 18 });
  mocks.write.mockResolvedValue({ bytes: 4 });
  mocks.generate.mockResolvedValue({ text: "Verified findings", toolCalls: [] });
});

describe("trusted agent execution propagation", () => {
  it("rejects a missing context before orchestration memory or model work", async () => {
    await expect(orchestrate({ projectId: "registered", prompt: "Implement backend API" })).rejects.toThrow("Authentication required");
    expect(mocks.appendMemory).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("rejects fabricated context before direct read runtime lookup", async () => {
    await expect(executeTool("read_file", { path: "README.md" }, { ...toolContext(), authorization: {} as ExecutionAuthorizationContext })).rejects.toThrow("Authentication required");
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("passes the exact capability through orchestration, executor, loop and runtime", async () => {
    mocks.generate.mockImplementation(async (options) => options.prompt.includes("Tool read_file")
      ? { text: "Verified findings", toolCalls: [] }
      : { text: "", toolCalls: [{ toolName: "read_file", input: { path: "README.md" } }] });
    await orchestrate({ projectId: "registered", prompt: "Inspect architecture" }, undefined, authorization);
    expect(mocks.runtime).toHaveBeenCalledWith("registered", authorization);
    expect(mocks.generate.mock.calls.every(([options]) => options.abortSignal === controller.signal)).toBe(true);
    expect(mocks.check.mock.calls.every(([candidate, projectId]) => candidate === authorization && projectId === "registered")).toBe(true);
    expect(JSON.stringify(mocks.generate.mock.calls)).not.toContain("ownerId");
  });

  it("rejects model project substitution before runtime resolution", async () => {
    const result = await executeTool("read_file", { path: "README.md", projectId: "other-project" }, toolContext());
    expect(result).toMatchObject({ ok: false, error: "Invalid tool parameters." });
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("does not accept an owner role claim or elevate a reviewer to writer", async () => {
    await expect(executeTool("write_file", { path: "README.md", content: "bad" }, { ...toolContext("security"), actorRole: "owner" })).rejects.toThrow("not permitted");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.policy).not.toHaveBeenCalled();
  });

  it("rejects an escalated tool list and a substituted actor before any provider call", async () => {
    await expect(runAgentWithTools({ ...input(), agentId: "security", context: toolContext("security") })).rejects.toThrow("not permitted");
    await expect(runAgentWithTools({ ...input(), context: toolContext("security") })).rejects.toThrow("not permitted");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("retains read operations for read-only agents and never grants write tools", () => {
    expect(getAgentToolPreset("architect")).toContain("read_file");
    expect(getAgentToolPreset("architect")).not.toContain("write_file");
    expect(getAgentToolPreset("unknown")).toEqual([]);
  });

  it("retains approval checks for an authorized writer", async () => {
    mocks.policy.mockReturnValue({ allowed: false, approvalRequired: true, reason: "Approval required" });
    const result = await executeTool("write_file", { path: "README.md", content: "edit" }, toolContext());
    expect(result.requiresApproval).toBe(true);
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("stops between tool calls after revocation without subsequent writes or model calls", async () => {
    mocks.generate.mockResolvedValue({ text: "", toolCalls: [
      { toolName: "read_file", input: { path: "README.md" } },
      { toolName: "write_file", input: { path: "README.md", content: "forbidden" } },
    ] });
    mocks.read.mockImplementation(async () => { active = false; return { content: "completed read", bytes: 14 }; });
    await expect(runAgentWithTools(input())).rejects.toThrow("Authentication required");
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
  });

  it("rejects a provider completion after expiry before tools or memory writes", async () => {
    mocks.generate.mockImplementation(async () => { active = false; return { text: "", toolCalls: [{ toolName: "write_file", input: { path: "README.md", content: "late" } }] }; });
    await expect(executeTask("registered", task, buildInitialDashboard(), undefined, undefined, authorization)).rejects.toThrow("Authentication required");
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.localNote).not.toHaveBeenCalled();
  });

  it("propagates request cancellation to a pending model and does not continue", async () => {
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    mocks.generate.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(new Error("Provider request aborted")), { once: true });
      started();
    }));
    const run = runAgentWithTools(input());
    const rejected = expect(run).rejects.toThrow("Authentication required");
    await pending;
    controller.abort();
    await rejected;
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it("awaits streaming progress and revalidates before starting model work", async () => {
    const events: string[] = [];
    await expect(orchestrate({ projectId: "registered", prompt: "Inspect code" }, async (event) => {
      await Promise.resolve();
      events.push(event.type);
      active = false;
    }, authorization)).rejects.toThrow("Authentication required");
    expect(events).toEqual(["agent_update"]);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.localNote).not.toHaveBeenCalled();
  });
});
