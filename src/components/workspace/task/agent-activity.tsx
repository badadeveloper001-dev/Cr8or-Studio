"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { cn } from "@/lib/utils";
import { summarizeAgents } from "@/components/workspace/task/task-utils";
import type { AgentStatus } from "@/lib/agents/types";

const STATUS_TONE: Record<AgentStatus, string> = {
  completed: "text-success",
  running: "text-accent",
  failed: "text-danger",
  blocked: "text-warning",
  pending: "text-text-muted",
  idle: "text-text-muted",
};

const DOT_TONE: Record<AgentStatus, string> = {
  completed: "bg-success",
  running: "bg-accent",
  failed: "bg-danger",
  blocked: "bg-warning",
  pending: "bg-text-muted",
  idle: "bg-text-muted",
};

export function AgentActivity() {
  const { agentList } = useWorkspaceControllerContext();
  const [expanded, setExpanded] = useState(false);

  const summary = summarizeAgents(agentList);
  if (!summary) return null;

  const dotStatus: AgentStatus =
    summary.active.length > 0
      ? "running"
      : summary.failed.length > 0
        ? "failed"
        : summary.waiting.length > 0
          ? "blocked"
          : "completed";

  return (
    <div className="rounded-lg border border-border-strong bg-surface px-3.5 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            DOT_TONE[dotStatus],
            summary.active.length > 0 && "animate-pulse",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{summary.headline}</span>
        <span className="shrink-0 text-[10px] text-text-muted">
          {summary.active.length > 0
            ? `${summary.active.length} active`
            : `${summary.completed.length}/${summary.total} done`}
        </span>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        )}
      </button>

      {expanded ? (
        <ul className="mt-2.5 space-y-1.5">
          {agentList.map((agent) => (
            <li key={agent.agentId} className="rounded-md border border-border-strong px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{agent.name}</span>
                <span className={cn("shrink-0 text-[10px] capitalize", STATUS_TONE[agent.status])}>
                  {agent.status}
                </span>
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${agent.progress}%` }}
                />
              </div>
              {agent.currentTask ? (
                <p className="mt-1 truncate text-[10px] text-text-muted">{agent.currentTask}</p>
              ) : null}
              {agent.thinking ? (
                <p className="mt-0.5 line-clamp-2 text-[10px] text-text-muted">{agent.thinking}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
