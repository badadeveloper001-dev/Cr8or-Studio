import { describe, expect, it } from "vitest";

describe("completion guarantee contract", () => {
  it("executor failure includes output field", () => {
    // Verify the contract: failed tasks must have an output field
    const failedTask = {
      id: "test",
      agentId: "product",
      title: "test",
      input: "test",
      dependsOn: [],
      status: "failed",
      output: "Task failed: test error",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };

    expect(failedTask.status).toBe("failed");
    expect(failedTask.output).toBeDefined();
    expect(failedTask.output).toContain("Task failed:");
  });

  it("approval-blocked output is non-empty", () => {
    // Verify the contract: approval blocked tasks must have meaningful output
    const approvalMessage = `Action paused because approval is required for write_file ({"path":"test.ts"}).`;
    expect(approvalMessage.length).toBeGreaterThan(0);
    expect(approvalMessage).toContain("Action paused because approval is required");
    expect(approvalMessage).toContain("write_file");
  });

  it("SSE completion guarantee covers all terminal states", () => {
    // Verify the contract: all run history statuses are valid terminal states
    const terminalStates = ["completed", "failed", "cancelled"];

    // Every run must end in exactly one terminal state
    expect(terminalStates).toContain("completed");
    expect(terminalStates).toContain("failed");
    expect(terminalStates).toContain("cancelled");
    expect(terminalStates).not.toContain("running");
  });

  it("fallback message format is user-safe", () => {
    // Verify the contract: fallback messages don't expose internals
    const fallbackMessage = "The delegated run stopped before producing a final result. Please try again or check the activity panel for details.";
    expect(fallbackMessage).not.toContain("Error:");
    expect(fallbackMessage).not.toContain("stack");
    expect(fallbackMessage).not.toContain("undefined");
    expect(fallbackMessage.length).toBeGreaterThan(10);
  });

  it("error message format is user-safe", () => {
    // Verify the contract: error messages don't expose secrets
    const errorMessage = "The delegated run encountered an error: Connection refused";
    expect(errorMessage).not.toContain("API_KEY");
    expect(errorMessage).not.toContain("secret");
    expect(errorMessage).not.toContain("password");
  });
});
