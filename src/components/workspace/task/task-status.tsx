"use client";

import React from "react";
import { AlertTriangle, CheckCircle2, Circle, Eye, Loader2, ShieldAlert, Zap, Search, MessageSquare, Brain, FileText, Wrench, AlertOctagon, HelpCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { TaskStatusKind } from "@/components/workspace/task/task-utils";
import type { IntentClass } from "@/lib/intent/types";

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

const INTENT_CONFIG: Record<
  IntentClass,
  { label: string; Icon: LucideIcon; tone: string }
> = {
  conversation: { label: "Conversation", Icon: MessageSquare, tone: "text-text-muted" },
  explanation: { label: "Explanation", Icon: FileText, tone: "text-accent" },
  brainstorming: { label: "Brainstorming", Icon: Brain, tone: "text-accent" },
  planning: { label: "Planning", Icon: Search, tone: "text-accent" },
  read_only_inspection: { label: "Inspecting", Icon: Eye, tone: "text-accent" },
  direct_action: { label: "Acting", Icon: Wrench, tone: "text-success" },
  specialist_delegation: { label: "Delegating", Icon: Zap, tone: "text-warning" },
  high_risk_action: { label: "High risk", Icon: AlertOctagon, tone: "text-danger" },
  unclear: { label: "Unclear", Icon: HelpCircle, tone: "text-text-muted" },
};

export function TaskStatus({ 
  status, 
  className, 
  intent 
}: { 
  status: TaskStatusKind; 
  className?: string; 
  intent?: IntentClass;
}) {
  const { label, Icon, tone, spin } = STATUS_CONFIG[status];
  const intentIcon = intent ? INTENT_CONFIG[intent].Icon : null;
  const intentLabel = intent ? INTENT_CONFIG[intent].label : null;

  return (
    <span role="status" className={cn("inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium", tone, className)}>
      <Icon className={cn("h-3.5 w-3.5", spin && "animate-spin")} aria-hidden="true" />
      {label}
      {intent && intentIcon && intentLabel && (
        <React.Fragment>
          <span className="text-text-muted">·</span>
          <span className="inline-flex items-center gap-1 text-[10px] text-text-secondary">
            {React.createElement(intentIcon, { className: "h-3 w-3", "aria-hidden": "true" })}
            {intentLabel}
          </span>
        </React.Fragment>
      )}
    </span>
  );
}
