"use client";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  completed: "text-success",
  verified: "text-success",
  passed: "text-success",
  failed: "text-danger",
  blocked: "text-danger",
  running: "text-accent",
  pending: "text-text-muted",
  cancelled: "text-text-muted",
};

type ActivityItem = {
  id: string;
  label: string;
  status: string;
  detail?: string;
};

function formatDuration(durationMs: number) {
  if (!durationMs || durationMs <= 0) return undefined;
  return `${Math.round(durationMs / 100) / 10}s`;
}

export function CommandActivity() {
  const { executionReceipts, runHistory, setShowBottomPanel } = useWorkspaceControllerContext();

  const items: ActivityItem[] = [
    ...executionReceipts.slice(0, 3).map((receipt) => ({
      id: `receipt-${receipt.id}`,
      label: receipt.title,
      status: receipt.status,
      detail: new Date(receipt.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    })),
    ...runHistory.slice(0, 3).map((run) => ({
      id: `run-${run.id}`,
      label: run.prompt,
      status: run.status,
      detail: formatDuration(run.durationMs),
    })),
  ].slice(0, 4);

  if (items.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border-strong px-4 py-1.5">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        Activity
      </span>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setShowBottomPanel(true)}
          title="Open terminal"
          className="inline-flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full border border-border-strong px-2.5 py-1 text-[11px] transition-colors hover:bg-surface-muted"
        >
          <span className={cn("capitalize", STATUS_STYLES[item.status] ?? "text-text-muted")}>
            {item.status}
          </span>
          <span className="truncate text-text-secondary">{item.label}</span>
          {item.detail ? <span className="shrink-0 text-text-muted">{item.detail}</span> : null}
        </button>
      ))}
    </div>
  );
}
