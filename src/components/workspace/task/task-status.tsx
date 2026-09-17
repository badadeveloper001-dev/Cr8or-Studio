"use client";

import { AlertTriangle, CheckCircle2, Circle, Eye, Loader2, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { TaskStatusKind } from "@/components/workspace/task/task-utils";

const STATUS_CONFIG: Record<
  TaskStatusKind,
  { label: string; Icon: LucideIcon; tone: string; spin?: boolean }
> = {
  idle: { label: "Idle", Icon: Circle, tone: "text-text-muted" },
  thinking: { label: "Thinking", Icon: Loader2, tone: "text-accent", spin: true },
  working: { label: "Working", Icon: Loader2, tone: "text-accent", spin: true },
  "needs-approval": { label: "Needs approval", Icon: ShieldAlert, tone: "text-warning" },
  "ready-for-review": { label: "Ready for review", Icon: Eye, tone: "text-accent" },
  completed: { label: "Completed", Icon: CheckCircle2, tone: "text-success" },
  failed: { label: "Failed", Icon: AlertTriangle, tone: "text-danger" },
};

export function TaskStatus({ status, className }: { status: TaskStatusKind; className?: string }) {
  const { label, Icon, tone, spin } = STATUS_CONFIG[status];

  return (
    <span role="status" className={cn("inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium", tone, className)}>
      <Icon className={cn("h-3.5 w-3.5", spin && "animate-spin")} aria-hidden="true" />
      {label}
    </span>
  );
}
