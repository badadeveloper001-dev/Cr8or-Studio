import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/agents/executor", () => ({ executeTask: mocks.execute, buildInitialDashboard: () => [] }));
vi.mock("@/lib/agents/memory", () => ({ appendGlobalMemory: vi.fn() }));
import { orchestrate } from "@/lib/agents/orchestrator";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.execute.mockImplementation(async (_project, task) => ({ ...task, status: "completed", output: `Verified output from ${task.agentId}` }));
});
describe("specialist delivery", () => {
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
