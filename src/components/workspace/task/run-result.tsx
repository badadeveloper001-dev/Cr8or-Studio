"use client";

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { RunResultData, RunResultTone } from "@/components/workspace/task/task-utils";

const TONE_CONFIG: Record<RunResultTone, { Icon: LucideIcon; tone: string }> = {
  success: { Icon: CheckCircle2, tone: "text-success" },
  danger: { Icon: XCircle, tone: "text-danger" },
  warning: { Icon: AlertTriangle, tone: "text-warning" },
  neutral: { Icon: Info, tone: "text-text-muted" },
};

function formatDuration(durationMs: number): string {
  if (!durationMs || durationMs <= 0) return "";
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function RunResult({ result }: { result: RunResultData }) {
  const { Icon, tone } = TONE_CONFIG[result.tone];

  return (
    <div className="rounded-lg border border-border-strong bg-surface px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-xs text-text-primary">{result.title}</p>
        <span className={cn("shrink-0 text-[10px] capitalize", tone)}>{result.status}</span>
      </div>
      {result.meta && result.meta.length > 0 ? (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {result.meta.map((item) => (
            <div key={item.label} className="text-[11px]">
              <dt className="inline text-text-muted">{item.label} </dt>
              <dd className="inline text-text-secondary">{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {result.toolReceipts && result.toolReceipts.length > 0 ? (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] font-medium text-text-muted">Tool Activity</p>
          {result.toolReceipts.slice(0, 5).map((receipt, index) => (
            <div
              key={index}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border-strong p-1.5 text-[10px]",
                receipt.workspaceChanged && "border-success/40 bg-success/5",
                receipt.requiresApproval && "border-warning/40 bg-warning/5"
              )}
            >
              {receipt.requiresApproval ? (
                <AlertTriangle className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
              ) : receipt.status === "completed" ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <XCircle className="h-3 w-3 shrink-0 text-danger" aria-hidden="true" />
              )}
              <span className="flex-1 truncate font-mono text-text-secondary">
                {receipt.agent}: {receipt.tool}
              </span>
              <span className={cn("shrink-0 capitalize", {
                "text-success": receipt.status === "completed",
                "text-danger": receipt.status === "failed",
                "text-warning": receipt.status === "blocked",
              })}>
                {receipt.status}
              </span>
              {receipt.workspaceChanged && (
                <span className="shrink-0 text-success text-[9px]">● changed</span>
              )}
              {receipt.durationMs && (
                <span className="shrink-0 text-text-muted">{formatDuration(receipt.durationMs)}</span>
              )}
            </div>
          ))}
          {result.toolReceipts.length > 5 && (
            <p className="text-[10px] text-text-muted">+{result.toolReceipts.length - 5} more actions</p>
          )}
        </div>
      ) : null}
      {result.details && result.details.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {result.details.slice(0, 4).map((detail, index) => (
            <li key={index} className="truncate text-[10px] text-text-muted">
              {detail}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
