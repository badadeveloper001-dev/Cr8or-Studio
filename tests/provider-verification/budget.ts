/** Aggregate bounds for the standalone offline runner, in addition to every
 * application and controlled adapter's own limits. This module has no provider
 * capability and does not alter application authorization or release gates. */
export const OFFLINE_RUN_BUDGET = Object.freeze({ durationMs: 300_000, operations: 10_000 });
let startedAt: number | undefined;
let operations = 0;

export type OfflineBudgetSnapshot = Readonly<{
  started: boolean;
  maximumDurationMs: 300000;
  maximumOperations: 10000;
  elapsedMs: number;
  operations: number;
  remainingOperations: number;
  deadlineExceeded: boolean;
}>;

/** The runner starts one fixed budget. Restarting it cannot extend a run. Tests
 * that directly exercise adapters without the runner retain their local bounds. */
export function beginOfflineBudget(): void {
  if (startedAt !== undefined) throw new Error("The offline verification budget is already active.");
  startedAt = performance.now();
}

/** Reserve before a controlled provider-shaped call. Never retries or dispatches
 * work after the deadline/count is exhausted. No caller can supply higher limits. */
export function consumeOfflineOperation(): void {
  if (startedAt === undefined) return;
  if (performance.now() - startedAt >= OFFLINE_RUN_BUDGET.durationMs || operations >= OFFLINE_RUN_BUDGET.operations) {
    throw new Error("The offline verification resource budget is exhausted.");
  }
  operations++;
}

export function snapshotOfflineBudget(): OfflineBudgetSnapshot {
  const elapsedMs = startedAt === undefined ? 0 : Math.max(0, Math.floor(performance.now() - startedAt));
  return Object.freeze({ started: startedAt !== undefined, maximumDurationMs: OFFLINE_RUN_BUDGET.durationMs,
    maximumOperations: OFFLINE_RUN_BUDGET.operations, elapsedMs, operations,
    remainingOperations: OFFLINE_RUN_BUDGET.operations - operations,
    deadlineExceeded: startedAt !== undefined && elapsedMs >= OFFLINE_RUN_BUDGET.durationMs });
}
