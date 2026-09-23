import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/agents/executor", () => ({ executeTask: mocks.execute, buildInitialDashboard: () => [] }));
vi.mock("@/lib/agents/memory", () => ({ appendGlobalMemory: vi.fn() }));
import { orchestrate } from "@/lib/agents/orchestrator";
import { AGENT_TOOL_TIER_MAP } from "@/lib/agents/tools";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.execute.mockImplementation(async (_project, task) => ({ ...task, status: "completed", output: `Verified output from ${task.agentId}` }));
});
describe("specialist delivery", () => {
  it("preserves multiple specialists for implementation requests", async () => {
    const result = await orchestrate({ projectId: "test", prompt: "Implement a backend API" });
    expect(result.timeline.map(task => task.agentId)).toEqual(expect.arrayContaining(["backend", "database"]));
    expect(result.timeline.find(task => task.agentId === "backend")?.dependsOn).toContain(result.timeline.find(task => task.agentId === "database")?.id);
  });
  it("keeps domain specialists and adds a writer only when missing", async () => {
    const prompt = "Conversation so far:\nUser: Propose the smallest safe code fix. Do not modify anything yet.\nCr8or AI: Implementation plan: update components/buyer-auth.tsx to remove the duplicate call.\nUser: Approved, proceed\nCr8or AI:";
    const result = await orchestrate({ projectId: "test", prompt });
    expect(result.timeline.some(task => AGENT_TOOL_TIER_MAP[task.agentId] === "writer")).toBe(true);
    expect(result.timeline.some(task => task.agentId === "product")).toBe(true);
  });
  it("provides writer capability for direct buyer-login implementation", async () => {
    const result = await orchestrate({ projectId: "test", prompt: "Implement the buyer login fix" });
    expect(result.timeline.some(task => AGENT_TOOL_TIER_MAP[task.agentId] === "writer")).toBe(true);
  });
  it("does real work even when the prompt has no routing keyword", async () => {
    const result = await orchestrate({ projectId: "test", prompt: "Fix it please" });
    expect(mocks.execute).toHaveBeenCalled();
    expect(result.timeline.length).toBeGreaterThan(0);
  });
  it("passes completed dependency findings to the next specialist", async () => {
    await orchestrate({ projectId: "test", prompt: "Implement a backend API" });
    const task = mocks.execute.mock.calls.find(([,task]) => task.agentId === "backend")?.[1];
    expect(task.input).toContain("Verified output from database");
  });
  it("does not run a dependent specialist after its prerequisite failed", async () => {
    mocks.execute.mockImplementation(async (_project, task) => ({ ...task, status: "failed", output: "Provider unavailable" }));
    const result = await orchestrate({ projectId: "test", prompt: "Implement a backend API" });
    expect(mocks.execute.mock.calls.some(([,task]) => task.agentId === "backend")).toBe(false);
    expect(result.summary).toMatch(/failed|blocked/i);
  });
});
