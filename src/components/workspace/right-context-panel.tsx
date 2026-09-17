"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Play, StopCircle, X } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { cn } from "@/lib/utils";
import type { AgentStatus, AgentTask } from "@/lib/agents/types";
import type { DelegationPolicy } from "@/hooks/use-workspace-controller";

type ContextTab = "changes" | "agents" | "run" | "approvals";

const TABS: Array<{ id: ContextTab; label: string }> = [
  { id: "changes", label: "Changes" },
  { id: "agents", label: "Agents" },
  { id: "run", label: "Run" },
  { id: "approvals", label: "Approvals" },
];

const AGENT_STATUS_STYLES: Record<AgentStatus, string> = {
  completed: "text-success",
  running: "text-accent",
  failed: "text-danger",
  blocked: "text-warning",
  pending: "text-text-muted",
  idle: "text-text-muted",
};

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-border-strong bg-surface px-2.5 text-xs text-text-primary outline-none transition-colors focus:border-accent";

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-xs leading-relaxed text-text-muted">{children}</p>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">{children}</p>;
}

function OutputItem({ task }: { task: AgentTask }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="rounded-md border border-border-strong">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <span className={cn("text-[10px] capitalize", AGENT_STATUS_STYLES[task.status])}>{task.status}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{task.title}</span>
        {expanded ? (
          <ChevronUp className="h-3 w-3 shrink-0 text-text-muted" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
        )}
      </button>
      {expanded && task.output ? (
        <pre className="whitespace-pre-wrap border-t border-border-strong px-2.5 py-2 font-mono text-[11px] leading-relaxed text-text-secondary">
          {task.output}
        </pre>
      ) : null}
    </li>
  );
}

export function ChangesTab({ onOpenSourceControl }: { onOpenSourceControl?: () => void }) {
  const { gitSnapshot } = useWorkspaceControllerContext();
  if (!gitSnapshot) {
    return <Note>No git status loaded yet. Refresh from Source Control.</Note>;
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-border-strong px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs text-text-primary">Branch: {gitSnapshot.branch || "unknown"}</p>
          <p className="mt-0.5 text-[11px] text-text-muted">{gitSnapshot.changedCount} changed</p>
        </div>
        {onOpenSourceControl ? (
          <button
            type="button"
            onClick={onOpenSourceControl}
            className="shrink-0 text-[11px] text-accent hover:underline"
          >
            Source control
          </button>
        ) : null}
      </div>
      {gitSnapshot.changedFiles.length === 0 ? (
        <Note>Working tree is clean.</Note>
      ) : (
        <ul className="divide-y divide-border-strong">
          {gitSnapshot.changedFiles.slice(0, 30).map((change) => (
            <li key={`${change.status}-${change.path}`} className="px-3 py-1.5">
              <p className="truncate text-xs text-text-primary">{change.path}</p>
              <p className="text-[10px] uppercase tracking-wide text-text-muted">{change.status}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AgentsTab() {
  const { agentList, isRunning } = useWorkspaceControllerContext();
  if (agentList.length === 0) {
    return <Note>{isRunning ? "Agents are starting up." : "No active run."}</Note>;
  }
  return (
    <ul className="space-y-2 p-3">
      {agentList.map((agent) => (
        <li key={agent.agentId}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{agent.name}</span>
            <span className={cn("text-[10px] capitalize", AGENT_STATUS_STYLES[agent.status])}>{agent.status}</span>
          </div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${agent.progress}%` }} />
          </div>
          {agent.thinking ? <p className="mt-1 truncate text-[10px] text-text-muted">{agent.thinking}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function RunTab() {
  const {
    prompt,
    isRunning,
    running,
    completed,
    delegationPolicy,
    setDelegationPolicy,
    runOrchestration,
    leadInsights,
    visibleTimeline,
    hiddenTimelineCount,
    timeline,
    executionReceipts,
    visibleReceipts,
    hiddenReceiptCount,
    synthesis,
    statusLine,
  } = useWorkspaceControllerContext();

  return (
    <div className="space-y-5 p-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Run</SectionLabel>
          <span className="text-[11px] text-text-muted">
            {isRunning ? `${running} running${completed > 0 ? ` · ${completed} done` : ""}` : "Idle"}
          </span>
        </div>
        <select
          value={delegationPolicy}
          onChange={(event) => setDelegationPolicy(event.target.value as DelegationPolicy)}
          aria-label="Delegation policy"
          className={INPUT_CLASS}
        >
          <option value="auto">Auto delegate</option>
          <option value="ask">Ask before run</option>
          <option value="chat-only">Chat only</option>
        </select>
        <button
          type="button"
          onClick={() => void runOrchestration(prompt, "manual")}
          disabled={isRunning}
          className={cn(
            "flex h-9 w-full items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors disabled:opacity-50",
            isRunning
              ? "border border-border-strong text-text-secondary hover:bg-surface-muted"
              : "bg-accent text-accent-foreground hover:opacity-90",
          )}
        >
          {isRunning ? <StopCircle className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {isRunning ? "Running..." : "Delegate via Cr8or AI"}
        </button>
        <p className="truncate text-[11px] text-text-muted">{statusLine}</p>
      </div>

      <div className="space-y-2">
        <SectionLabel>Lead insights</SectionLabel>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${leadInsights.confidence}%` }} />
        </div>
        <p className="text-[11px] text-text-muted">Confidence {leadInsights.confidence}%</p>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div>
            <p className="text-text-muted">Latency</p>
            <p className="mt-0.5 text-text-primary">{Math.round(leadInsights.latencyMs / 100) / 10}s</p>
          </div>
          <div>
            <p className="text-text-muted">Cost</p>
            <p className="mt-0.5 text-text-primary">${leadInsights.estimatedCostUsd.toFixed(4)}</p>
          </div>
          <div>
            <p className="text-text-muted">Risks</p>
            <p className="mt-0.5 text-text-primary">{leadInsights.risks.length}</p>
          </div>
        </div>
        {leadInsights.risks.length > 0 ? (
          <ul className="space-y-0.5">
            {leadInsights.risks.slice(0, 3).map((risk) => (
              <li key={risk} className="text-[11px] leading-relaxed text-warning">
                {risk}
              </li>
            ))}
          </ul>
        ) : null}
        {synthesis ? (
          <p className="text-[11px] text-text-muted">
            Synthesis: requirements {synthesis.requirements.length}, architecture {synthesis.architecture.length},
            quality {synthesis.quality.length}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <SectionLabel>Outputs</SectionLabel>
        {hiddenTimelineCount > 0 ? (
          <p className="text-[10px] text-text-muted">
            Showing latest {visibleTimeline.length} of {timeline.length}.
          </p>
        ) : null}
        {timeline.length === 0 ? (
          <p className="text-xs text-text-muted">Agent outputs appear here after each work package.</p>
        ) : (
          <ul className="space-y-1.5">
            {visibleTimeline.map((task) => (
              <OutputItem key={task.id} task={task} />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <SectionLabel>Receipts</SectionLabel>
        {hiddenReceiptCount > 0 ? (
          <p className="text-[10px] text-text-muted">
            Showing latest {visibleReceipts.length} of {executionReceipts.length}.
          </p>
        ) : null}
        {visibleReceipts.length === 0 ? (
          <p className="text-xs text-text-muted">No receipts yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {visibleReceipts.slice(0, 6).map((receipt) => (
              <li key={receipt.id} className="rounded-md border border-border-strong px-2.5 py-1.5">
                <p className="text-[11px] text-text-primary">
                  [{receipt.status.toUpperCase()}] {receipt.title}
                </p>
                <p className="text-[10px] text-text-muted">{new Date(receipt.createdAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" /> : null}
    </div>
  );
}

export function ApprovalsTab() {
  const { approvals, isApprovalsBusy, approvalStatus, loadApprovals, decideApproval } = useWorkspaceControllerContext();

  return (
    <div>
      <div className="flex items-center justify-between border-b border-border-strong px-3 py-2">
        <SectionLabel>Approval center</SectionLabel>
        <button
          type="button"
          onClick={() => void loadApprovals()}
          disabled={isApprovalsBusy}
          className="text-[11px] text-accent hover:underline disabled:opacity-50"
        >
          {isApprovalsBusy ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {approvalStatus ? <p className="px-3 pt-2 text-[11px] text-text-muted">{approvalStatus}</p> : null}
      {approvals.length === 0 ? (
        <Note>No approval requests yet.</Note>
      ) : (
        <ul className="divide-y divide-border-strong">
          {approvals.slice(0, 20).map((approval) => (
            <li key={approval.id} className="px-3 py-2">
              <p className="truncate text-xs text-text-primary">{approval.title}</p>
              <p className="mt-0.5 text-[11px] text-text-muted">
                {approval.action} · <span className="capitalize">{approval.status}</span>
              </p>
              <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-1.5 font-mono text-[10px] text-text-secondary">
                {approval.preview}
              </pre>
              {approval.status === "pending" ? (
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void decideApproval(approval, "approved")}
                    disabled={isApprovalsBusy}
                    className="h-7 flex-1 rounded-md bg-accent text-[11px] font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void decideApproval(approval, "denied")}
                    disabled={isApprovalsBusy}
                    className="h-7 flex-1 rounded-md border border-border-strong text-[11px] text-text-secondary transition-colors hover:bg-surface-muted disabled:opacity-50"
                  >
                    Deny
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RightContextPanel({
  onClose,
  onOpenSourceControl,
}: {
  onClose: () => void;
  onOpenSourceControl?: () => void;
}) {
  const [tab, setTab] = useState<ContextTab>("changes");

  return (
    <aside
      aria-label="Context panel"
      className="hidden h-full w-80 shrink-0 flex-col border-l border-border-strong bg-surface lg:flex"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-strong pl-1 pr-1">
        <div role="tablist" aria-label="Context panel sections" className="flex min-w-0 items-center overflow-x-auto">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "h-11 shrink-0 px-2.5 text-xs transition-colors",
                tab === id ? "text-text-primary" : "text-text-muted hover:text-text-secondary",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Hide context panel"
          onClick={onClose}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === "changes" ? <ChangesTab onOpenSourceControl={onOpenSourceControl} /> : null}
        {tab === "agents" ? <AgentsTab /> : null}
        {tab === "run" ? <RunTab /> : null}
        {tab === "approvals" ? <ApprovalsTab /> : null}
      </div>
    </aside>
  );
}
