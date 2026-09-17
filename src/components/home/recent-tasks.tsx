"use client";

import { cn } from "@/lib/utils";

export type RecentTaskStatus = "running" | "completed" | "failed" | "cancelled";

export type RecentTask = {
  id: string;
  prompt: string;
  status: RecentTaskStatus;
  startedAt: number;
  durationMs: number;
  estimatedCostUsd: number;
};

const STATUS_STYLES: Record<RecentTaskStatus, string> = {
  running: "text-accent",
  completed: "text-success",
  failed: "text-danger",
  cancelled: "text-text-muted",
};

export function RecentTasks({ tasks }: { tasks: RecentTask[] }) {
  return (
    <section aria-labelledby="recent-tasks-heading">
      <h2 id="recent-tasks-heading" className="text-sm font-semibold tracking-tight text-text-primary">
        Recent tasks
      </h2>
      {tasks.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No tasks have run yet.</p>
      ) : (
        <ul className="mt-3">
          {tasks.slice(0, 6).map((task) => (
            <li
              key={task.id}
              className="flex min-h-12 flex-col gap-1 border-b border-border-strong py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{task.prompt}</span>
              <span className="flex shrink-0 items-center gap-4 text-xs text-text-muted">
                <span className={cn("capitalize", STATUS_STYLES[task.status])}>{task.status}</span>
                {task.durationMs > 0 ? <span>{Math.round(task.durationMs / 100) / 10}s</span> : null}
                {task.estimatedCostUsd > 0 ? <span>${task.estimatedCostUsd.toFixed(4)}</span> : null}
                <span className="hidden sm:inline">{new Date(task.startedAt).toLocaleDateString()}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
