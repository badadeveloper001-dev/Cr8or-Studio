import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe("fixed aggregate offline verification budget", () => {
  it("does not replace adapter limits outside the standalone runner", async () => {
    const budget = await import("../provider-verification/budget");
    budget.consumeOfflineOperation();
    expect(budget.snapshotOfflineBudget()).toMatchObject({ started: false, operations: 0,
      maximumOperations: 10000, maximumDurationMs: 300000, deadlineExceeded: false });
  });
  it("reserves at most 10000 operations and cannot restart to extend the run", async () => {
    const budget = await import("../provider-verification/budget");
    budget.beginOfflineBudget();
    for (let index = 0; index < 10000; index++) budget.consumeOfflineOperation();
    expect(() => budget.consumeOfflineOperation()).toThrow("resource budget is exhausted");
    expect(() => budget.beginOfflineBudget()).toThrow("already active");
    expect(budget.snapshotOfflineBudget()).toMatchObject({ started: true, operations: 10000, remainingOperations: 0 });
  });
  it("uses a monotonic 300-second deadline and rejects before the next operation", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budget = await import("../provider-verification/budget");
    budget.beginOfflineBudget();
    now += 299999;
    budget.consumeOfflineOperation();
    now += 1;
    expect(() => budget.consumeOfflineOperation()).toThrow("resource budget is exhausted");
    expect(budget.snapshotOfflineBudget()).toEqual({ started: true, maximumDurationMs: 300000,
      maximumOperations: 10000, elapsedMs: 300000, operations: 1, remainingOperations: 9999, deadlineExceeded: true });
  });
});
