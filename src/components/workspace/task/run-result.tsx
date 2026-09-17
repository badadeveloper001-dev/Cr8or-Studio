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
