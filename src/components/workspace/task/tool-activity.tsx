"use client";

import { useMemo } from "react";
import { FileText, Edit3, Terminal, GitBranch, AlertCircle, CheckCircle, Clock, Loader2 } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { cn } from "@/lib/utils";

type ToolActivityItem = {
  id: string;
  agentId: string;
  agentName: string;
  tool: string;
  label: string;
  status: "running" | "completed" | "failed" | "blocked" | "pending";
  detail?: string;
  startedAt: string;
  finishedAt?: string;
  requiresApproval: boolean;
  workspaceChanged: boolean;
};

const TOOL_LABELS: Record<string, { label: string; icon: typeof FileText }> = {
  read_file: { label: "Read", icon: FileText },
  list_files: { label: "List", icon: GitBranch },
  write_file: { label: "Edited", icon: Edit3 },
  git_status: { label: "Git status", icon: GitBranch },
  git_diff: { label: "Git diff", icon: GitBranch },
  run_command: { label: "Ran", icon: Terminal },
};

const STATUS_STYLES: Record<string, string> = {
  running: "text-accent",
  completed: "text-success",
  failed: "text-danger",
  blocked: "text-warning",
  pending: "text-text-muted",
};

function extractPathFromParams(paramsSummary: string): string | null {
  try {
    const params = JSON.parse(paramsSummary);
    if (params.path) return params.path;
    if (params.command) return params.command;
    return null;
  } catch {
    return null;
  }
}

function formatToolLabel(tool: string, paramsSummary: string): string {
  const toolInfo = TOOL_LABELS[tool] ?? { label: tool, icon: FileText };
  const path = extractPathFromParams(paramsSummary);
  if (path) {
    return `${toolInfo.label} ${path}`;
  }
  return toolInfo.label;
}

function formatToolStatus(record: ToolActivityItem): string {
  if (record.requiresApproval) return "Awaiting approval";
  if (record.status === "running") return "Running...";
  if (record.status === "completed") return "Completed";
  if (record.status === "failed") return `Failed${record.detail ? `: ${record.detail}` : ""}`;
  if (record.status === "blocked") return "Blocked";
  return "Pending";
}

export function ToolActivity() {
  const { timeline } = useWorkspaceControllerContext();

  const items = useMemo((): ToolActivityItem[] => {
    const allRecords: ToolActivityItem[] = [];

    for (const task of timeline) {
      if (!task.toolRecords || task.toolRecords.length === 0) continue;

      for (const record of task.toolRecords) {
        let status: ToolActivityItem["status"] = "completed";
        if (!record.ok) {
          if (record.requiresApproval) status = "blocked";
          else status = "failed";
        }

        allRecords.push({
          id: record.id,
          agentId: task.agentId,
          agentName: task.agentId,
          tool: record.tool,
          label: formatToolLabel(record.tool, record.paramsSummary),
          status,
          detail: record.error,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          requiresApproval: record.requiresApproval,
          workspaceChanged: record.workspaceChanged,
        });
      }
    }

    return allRecords.sort((a, b) =>
      new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    );
  }, [timeline]);

  if (items.length === 0) return null;

  return (
    <div className="rounded-lg border border-border-strong bg-surface px-3.5 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Tool Activity
        </span>
        <span className="text-[10px] text-text-muted">
          {items.length} action{items.length > 1 ? "s" : ""}
        </span>
      </div>
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex items-start gap-2 rounded-md border border-border-strong p-2 transition-colors",
              item.requiresApproval && "border-warning/40 bg-warning/5",
              item.workspaceChanged && "border-success/40 bg-success/5"
            )}
          >
            <div className="shrink-0 mt-0.5">
              {item.requiresApproval ? (
                <AlertCircle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
              ) : item.status === "running" ? (
                <Loader2 className="h-3.5 w-3.5 text-accent animate-spin" aria-hidden="true" />
              ) : item.status === "completed" ? (
                <CheckCircle className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              ) : item.status === "failed" ? (
                <AlertCircle className="h-3.5 w-3.5 text-danger" aria-hidden="true" />
              ) : (
                <Clock className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-text-primary truncate">{item.label}</p>
              <p className={cn("mt-0.5 text-[10px]", STATUS_STYLES[item.status])}>
                {formatToolStatus(item)}
              </p>
              {item.requiresApproval && (
                <p className="mt-1 text-[10px] text-warning">
                  Approval required to proceed
                </p>
              )}
              {item.workspaceChanged && !item.requiresApproval && (
                <p className="mt-1 text-[10px] text-success">
                  Workspace changed
                </p>
              )}
              {item.detail && item.status === "failed" && (
                <pre className="mt-1 max-h-16 overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-1.5 font-mono text-[9px] leading-relaxed text-text-secondary">
                  {item.detail}
                </pre>
              )}
            </div>
            <div className="shrink-0 text-[10px] text-text-muted">
              {new Date(item.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}