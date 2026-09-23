import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), policy: vi.fn(), read: vi.fn(), write: vi.fn(), command: vi.fn(), diff: vi.fn() }));
vi.mock("ai", () => ({ generateText: mocks.generate, dynamicTool: (x: unknown) => x, zodSchema: (x: unknown) => x }));
vi.mock("@/lib/agents/llm", () => ({ getDefaultLLMConfig: () => ({}), getModelForTools: () => ({}) }));
vi.mock("@/lib/security/policy", () => ({ evaluatePolicyGuard: mocks.policy }));
vi.mock("@/lib/security/audit", () => ({ appendAuditEvent: vi.fn() }));
vi.mock("@/lib/workspace/runtime-factory", () => ({ getWorkspaceRuntime: async () => ({ readFile: mocks.read, writeFile: mocks.write, runCommand: mocks.command, gitDiff: mocks.diff }) }));
vi.mock("@/lib/agents/memory", () => ({ appendGlobalMemory: vi.fn(), getGlobalMemory: () => ({ goals: [], architecture: [], codingStandards: [] }), getLocalMemory: () => ({ notes: [] }), writeLocalNote: vi.fn() }));

import { classifyIntentDeterministic } from "@/lib/intent/classifier";
import { isImplementationRequest } from "@/lib/intent/execution-request";
import { detectWorkspaceRequest } from "@/lib/workspace/workspace-request-detector";
import { runAgentWithTools, getAgentToolPreset, getDefaultToolPreset } from "@/lib/agents/tool-loop";
import { executeTool } from "@/lib/agents/tool-executor";

const inspection = "Inspect the buyer authentication flow. Do not modify anything.";
const planning = "Propose the smallest safe fix. Do not modify anything.";
const implementation = "Approved for Tier 1 only. Implement the buyer login duplicate-auth fix. Do not touch signup or OTP. Validate and show me the diff. Do not commit or push.";
const history = `User: ${inspection}\nCr8or AI: Inspection findings.\nUser: ${planning}\nCr8or AI: Implementation plan: update only components/buyer-auth.tsx, validate, and show the diff.`;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.policy.mockReturnValue({ allowed: true, approvalRequired: false });
  mocks.read.mockResolvedValue({ content: "original buyer auth", bytes: 19 });
  mocks.write.mockResolvedValue({ bytes: 20 });
  mocks.command.mockResolvedValue({ stdout: "passed", stderr: "", exitCode: 0 });
  mocks.diff.mockResolvedValue({ diff: "buyer auth diff", stagedDiff: "" });
});

describe("current-turn writer routing", () => {
  it.each(["Fix this TypeScript error", "Write the fix to components/buyer-auth.tsx", "Implement the login fix", "apply the fix", "make the change", "update the file", "fix this", "proceed with implementation", "approved, implement", "go ahead with the changes", implementation, "Implement the buyer login fix. Do not modify signup or OTP."])("routes implementation: %s", message => {
    expect(detectWorkspaceRequest(message).type).toBeNull();
    expect(classifyIntentDeterministic(message).allowedToolMode).toBe("write");
  });
  it.each(["Approved, proceed", "Approved for Tier 1", "Apply the changes we agreed", "Implement the plan we just agreed"])("uses prior plan for %s", message => {
    expect(classifyIntentDeterministic(message, history).allowedToolMode).toBe("write");
    expect(isImplementationRequest(message)).toBe(false);
  });
  it.each(["Write a plan for the login flow", "Write an implementation plan for fixing auth", "Explain how we should fix this", "Plan the changes first. Do not modify anything.", "Draft a technical proposal for fixing auth", "Create an analysis of the login failure"])("keeps prose and planning non-mutating: %s", message => {
    expect(classifyIntentDeterministic(message, history).allowedToolMode).not.toBe("write");
    expect(isImplementationRequest(message, history)).toBe(false);
  });
  it.each([
    "User: Explain what git changes means.",
    "User: Explain what git changes means.\nCr8or AI: Changes means edits to files.",
    "User: Propose a code fix.\nCr8or AI: We could fix things later.",
    "User: Propose a code fix.\nCr8or AI: Implementation complete; changes applied to components/buyer-auth.tsx.",
    `${history}\nUser: What does git status mean?\nCr8or AI: It reports changes.`,
    `${history}\n${"unrelated ".repeat(1800)}`,
  ])("does not authorize execution from unrelated, completed or stale history", previous => {
    expect(classifyIntentDeterministic("Approved, proceed", previous).allowedToolMode).not.toBe("write");
  });
  it("keeps inspection, explanation, planning and conversation out of writer mode", () => {
    expect(detectWorkspaceRequest("Inspect package.json")).toEqual({ type: "read_file", path: "package.json" });
    expect(detectWorkspaceRequest("Show git status").type).toBe("git_status");
    for (const message of [inspection, planning, "Explain this code", "hello", "Implement nothing. Do not modify anything.", "Can you implement a website?"]) {
      expect(classifyIntentDeterministic(message, history).allowedToolMode).not.toBe("write");
    }
    expect(getDefaultToolPreset()).not.toContain("write_file");
  });
  it("runs the exact approved third turn through a writer, validation and diff", async () => {
    expect(classifyIntentDeterministic(inspection).allowedToolMode).toBe("read-only");
    expect(classifyIntentDeterministic(planning).allowedToolMode).toBe("read-only");
    expect(classifyIntentDeterministic(implementation, history).allowedToolMode).toBe("write");
    for (const [toolName, input] of [
      ["read_file", { path: "components/buyer-auth.tsx" }],
      ["write_file", { path: "components/buyer-auth.tsx", content: "fixed buyer auth" }],
      ["run_command", { command: "npm run typecheck" }],
      ["git_diff", { path: "components/buyer-auth.tsx" }],
    ]) mocks.generate.mockResolvedValueOnce({ text: "", toolCalls: [{ toolName, input }] });
    mocks.generate.mockResolvedValueOnce({ text: "Fixed only buyer authentication; validation passed. buyer auth diff", toolCalls: [] });
    const result = await runAgentWithTools({ systemPrompt: "Inspect before editing. Respect the current scope. Do not commit or push.", userMessage: implementation, agentId: "frontend", toolNames: getAgentToolPreset("frontend"), context: { projectId: "fixture", workspaceRoot: "/repo", requestId: "test", actorId: "frontend", actorRole: "agent" }, task: { id: "fixture", agentId: "frontend", title: "Buyer login fix", input: implementation, dependsOn: [], status: "pending" } });
    expect(getAgentToolPreset("frontend")).toEqual(expect.arrayContaining(["read_file", "list_files", "write_file", "git_status", "git_diff", "run_command"]));
    expect(result.failed).not.toBe(true);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("components/buyer-auth.tsx", "fixed buyer auth");
    expect(mocks.command.mock.calls[0][0].command).toBe("npm run typecheck");
    expect(mocks.diff).toHaveBeenCalledWith("components/buyer-auth.tsx", undefined);
    expect(result.output).toContain("validation passed");
  });
  it("enforces file-write policy despite approval wording", async () => {
    mocks.policy.mockReturnValue({ allowed: false, approvalRequired: true, reason: "Approval required" });
    const context = { projectId: "fixture", workspaceRoot: "/repo", requestId: "test", actorId: "frontend", actorRole: "agent" };
    const result = await executeTool("write_file", { path: "components/buyer-auth.tsx", content: "fixed" }, context);
    expect(result.requiresApproval).toBe(true);
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.policy.mockReturnValue({ allowed: true, approvalRequired: false });
    expect((await executeTool("write_file", { path: "components/buyer-auth.tsx", content: "fixed" }, { ...context, approvalId: "approved-tool-action" })).ok).toBe(true);
    expect(mocks.policy.mock.calls.at(-1)?.[0].approvalId).toBe("approved-tool-action");
  });
});
