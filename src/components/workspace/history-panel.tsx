"use client";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { cn } from "@/lib/utils";

const RUN_STATUS_STYLES: Record<string, string> = {
  running: "text-accent",
  completed: "text-success",
  failed: "text-danger",
  cancelled: "text-text-muted",
};

export function HistoryPanel() {
  const { runHistory } = useWorkspaceControllerContext();

  if (runHistory.length === 0) {
    return <p className="px-3 py-3 text-xs leading-relaxed text-text-muted">No runs yet. Start a task to build history.</p>;
  }

  return (
    <ul className="divide-y divide-border-strong">
      {runHistory.map((run) => (
        <li key={run.id} className="px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-xs leading-snug text-text-primary">{run.prompt}</p>
            <span className={cn("shrink-0 text-[11px] capitalize", RUN_STATUS_STYLES[run.status] ?? "text-text-muted")}>
              {run.status}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-text-muted">
            {new Date(run.startedAt).toLocaleString()} · {Math.round(run.durationMs / 100) / 10}s · $
            {run.estimatedCostUsd.toFixed(4)}
          </p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            {run.completedAgents}/{run.totalAgents} agents · {run.confidence}% confidence · {run.riskCount} risks
          </p>
        </li>
      ))}
    </ul>
  );
}
