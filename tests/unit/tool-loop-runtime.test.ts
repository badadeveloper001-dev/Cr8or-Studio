import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), execute: vi.fn() }));
vi.mock("ai", () => ({ generateText: mocks.generate, dynamicTool: (x: unknown) => x, zodSchema: (x: unknown) => x }));
vi.mock("@/lib/agents/llm", () => ({ getDefaultLLMConfig: () => ({}), getModelForTools: () => ({}) }));
vi.mock("@/lib/agents/tool-executor", () => ({ executeTool: mocks.execute }));
import { runAgentWithTools } from "@/lib/agents/tool-loop";

const input = {
  systemPrompt: "Inspect the workspace.", userMessage: "Inspect architecture and explain how the app works.",
  agentId: "architect", toolNames: ["read_file", "list_files"] as const,
  context: { projectId: "test", workspaceRoot: "/repo", requestId: "test", actorId: "architect", actorRole: "agent" },
  task: { id: "test", agentId: "architect" as const, title: "Inspection", input: "Inspect", dependsOn: [], status: "pending" as const },
};
const run = () => runAgentWithTools({ ...input, toolNames: [...input.toolNames] });

beforeEach(() => { vi.clearAllMocks(); });
describe("tool execution continuation", () => {
  it("retains the original goal and every result across multiple tool turns", async () => {
    mocks.generate.mockResolvedValueOnce({ text: "Inspecting", toolCalls: [{ toolName: "list_files", input: { path: "." } }, { toolName: "read_file", input: { path: "package.json" } }] })
      .mockResolvedValueOnce({ text: "Architecture explanation", toolCalls: [] });
    mocks.execute.mockResolvedValueOnce({ ok: true, data: { files: ["unique-source-folder"] }, workspaceChanged: false })
      .mockResolvedValueOnce({ ok: true, data: { content: "unique-package-data" }, workspaceChanged: false });
    expect((await run()).output).toBe("Architecture explanation");
    const next = mocks.generate.mock.calls[1][0];
    const conversation = JSON.stringify(next.messages ?? next.prompt);
    expect(conversation).toContain(input.userMessage);
    expect(conversation).toContain("unique-source-folder");
    expect(conversation).toContain("unique-package-data");
  });
  it("synthesizes a final answer when the tool budget is exhausted", async () => {
    mocks.generate.mockImplementation(async (options) => options.tools
      ? { text: "", toolCalls: [{ toolName: "read_file", input: { path: "README.md" } }] }
      : { text: "Verified findings from the inspected files; further inspection is incomplete.", toolCalls: [] });
    mocks.execute.mockResolvedValue({ ok: true, data: { content: "README evidence" }, workspaceChanged: false });
    const result = await run();
    expect(result.output).toContain("Verified findings");
    expect(mocks.generate.mock.calls.at(-1)?.[0].tools).toBeUndefined();
  });
  it("rejects model calls to tools outside the assigned preset", async () => {
    mocks.generate.mockResolvedValueOnce({ text: "", toolCalls: [{ toolName: "write_file", input: { path: "README.md", content: "oops" } }] });
    await expect(run()).rejects.toThrow(/not allowed/i);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("preserves receipts if the provider fails after a successful tool call", async () => {
    mocks.generate.mockResolvedValueOnce({ text: "", toolCalls: [{ toolName: "read_file", input: { path: "README.md" } }] })
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    mocks.execute.mockResolvedValue({ ok: true, data: { content: "evidence" }, workspaceChanged: false });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.toolRecords).toHaveLength(1);
    expect(result.output).toContain("Provider unavailable");
  });
});
