import type { AgentExecutionState } from "@/lib/agents/types";

export type TaskStatusKind =
  | "idle"
  | "thinking"
  | "working"
  | "needs-approval"
  | "ready-for-review"
  | "completed"
  | "failed";

export type RunStatusLike = "running" | "completed" | "failed" | "cancelled";

export function mapTaskStatus(input: {
  isRunning: boolean;
  isChatting: boolean;
  hasPendingApproval: boolean;
  hasError: boolean;
  latestRunStatus?: RunStatusLike;
  changedCount: number;
}): TaskStatusKind {
  if (input.hasPendingApproval) return "needs-approval";
  if (input.isRunning) return "working";
  if (input.isChatting) return "thinking";
  if (input.hasError || input.latestRunStatus === "failed") return "failed";
  if (input.changedCount > 0) return "ready-for-review";
  if (input.latestRunStatus === "completed") return "completed";
  return "idle";
}

export type AgentSummary = {
  total: number;
  active: AgentExecutionState[];
  waiting: AgentExecutionState[];
  completed: AgentExecutionState[];
  failed: AgentExecutionState[];
  headline: string;
};

function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function summarizeAgents(agents: AgentExecutionState[]): AgentSummary | null {
  if (agents.length === 0) return null;

  const active = agents.filter((agent) => agent.status === "running");
  const waiting = agents.filter((agent) => agent.status === "pending" || agent.status === "blocked");
  const completed = agents.filter((agent) => agent.status === "completed");
  const failed = agents.filter((agent) => agent.status === "failed");

  let headline: string;
  if (active.length > 0) {
    headline =
      active.length <= 3 ? `Working with ${joinNames(active.map((agent) => agent.name))}` : `${active.length} agents active`;
  } else if (waiting.length > 0) {
    headline = waiting.length === 1 ? `${waiting[0].name} waiting` : `${waiting.length} agents waiting`;
  } else if (failed.length > 0) {
    headline = failed.length === 1 ? `${failed[0].name} failed` : `${failed.length} agents failed`;
  } else if (completed.length > 0) {
    headline = completed.length === 1 ? `${completed[0].name} completed` : `${completed.length} agents completed`;
  } else {
    headline = `${agents.length} agents`;
  }

  return { total: agents.length, active, waiting, completed, failed, headline };
}

export type RunResultTone = "success" | "danger" | "warning" | "neutral";

export type RunResultData = {
  id: string;
  title: string;
  status: string;
  tone: RunResultTone;
  meta?: Array<{ label: string; value: string }>;
  details?: string[];
  toolReceipts?: Array<{
    agent: string;
    tool: string;
    status: "completed" | "failed" | "blocked";
    workspaceChanged: boolean;
    requiresApproval: boolean;
    durationMs?: number;
  }>;
};

type RunHistoryLike = {
  id: string;
  prompt: string;
  status: RunStatusLike;
  durationMs: number;
  completedAgents: number;
  totalAgents: number;
  confidence: number;
  estimatedCostUsd: number;
};

type AgentTaskLike = {
  id: string;
  agentId: string;
  status: string;
  toolRecords?: Array<{
    id: string;
    tool: string;
    ok: boolean;
    workspaceChanged: boolean;
    requiresApproval: boolean;
    startedAt: string;
    finishedAt: string;
  }>;
  workspaceChanged?: boolean;
};

type ReceiptLike = {
  id: string;
  kind: "orchestration" | "git" | "deploy" | "github";
  title: string;
  status: "verified" | "failed" | "pending";
  evidence: string[];
};

type SynthesisLike = {
  requirements: unknown[];
  architecture: unknown[];
  implementation: unknown[];
  quality: unknown[];
  deployment: unknown[];
  docs: unknown[];
};

export function buildRunResults(input: {
  runHistory: RunHistoryLike[];
  receipts: ReceiptLike[];
  synthesis: SynthesisLike | null;
  timeline?: AgentTaskLike[];
}): RunResultData[] {
  const results: RunResultData[] = [];
  const latest = input.runHistory[0];

  if (latest && latest.status !== "running") {
    const tone: RunResultTone =
      latest.status === "completed" ? "success" : latest.status === "failed" ? "danger" : "neutral";
    const meta: Array<{ label: string; value: string }> = [];
    if (latest.durationMs > 0) meta.push({ label: "Duration", value: formatDuration(latest.durationMs) });
    if (latest.totalAgents > 0) meta.push({ label: "Agents", value: `${latest.completedAgents}/${latest.totalAgents}` });
    if (latest.confidence > 0) meta.push({ label: "Confidence", value: `${latest.confidence}%` });
    if (latest.estimatedCostUsd > 0) meta.push({ label: "Cost", value: `$${latest.estimatedCostUsd.toFixed(4)}` });

    // Collect tool receipts from timeline
    const toolReceipts: RunResultData["toolReceipts"] = [];
    if (input.timeline) {
      for (const task of input.timeline) {
        if (task.toolRecords) {
          for (const record of task.toolRecords) {
            const started = new Date(record.startedAt).getTime();
            const finished = new Date(record.finishedAt).getTime();
            toolReceipts.push({
              agent: task.agentId,
              tool: record.tool,
              status: record.ok ? "completed" : record.requiresApproval ? "blocked" : "failed",
              workspaceChanged: record.workspaceChanged,
              requiresApproval: record.requiresApproval,
              durationMs: finished - started,
            });
          }
        }
      }
    }

    results.push({
      id: `run-${latest.id}`,
      title: latest.status === "completed" ? "Run completed" : latest.status === "failed" ? "Run failed" : "Run cancelled",
      status: latest.status,
      tone,
      meta,
      details: latest.prompt ? [latest.prompt] : [],
      toolReceipts: toolReceipts.length > 0 ? toolReceipts : undefined,
    });
  }

  for (const receipt of input.receipts) {
    if (receipt.kind === "orchestration") continue;
    if (results.length >= 3) break;
    results.push({
      id: `receipt-${receipt.id}`,
      title: receipt.title,
      status: receipt.status,
      tone: receipt.status === "verified" ? "success" : receipt.status === "failed" ? "danger" : "neutral",
      meta: [{ label: "Action", value: receipt.kind }],
      details: receipt.evidence.slice(0, 2),
    });
  }

  if (input.synthesis && results.length < 3) {
    results.push({
      id: "synthesis",
      title: "Synthesis ready",
      status: "available",
      tone: "neutral",
      meta: [
        { label: "Requirements", value: String(input.synthesis.requirements.length) },
        { label: "Architecture", value: String(input.synthesis.architecture.length) },
        { label: "Quality", value: String(input.synthesis.quality.length) },
      ],
    });
  }

  return results;
}

export function formatDuration(durationMs: number): string {
  if (!durationMs || durationMs <= 0) return "";
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
