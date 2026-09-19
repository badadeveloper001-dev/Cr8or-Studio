import { agentCatalog } from "@/lib/agents/catalog";
import { runAgentLLM } from "@/lib/agents/llm";
import { runAgentWithTools, getAgentToolPreset } from "@/lib/agents/tool-loop";
import { getGlobalMemory, getLocalMemory, writeLocalNote } from "@/lib/agents/memory";
import { agentSystemPrompts } from "@/lib/agents/prompts";
import { AgentExecutionState, AgentTask, ToolCallRecord, ToolProgressEvent } from "@/lib/agents/types";
import { ToolContext, ToolName } from "@/lib/agents/tools";
import { getWorkspaceRuntime } from "@/lib/workspace/runtime-factory";

export type TaskProgressCallback = (state: AgentExecutionState) => void;
export type ToolProgressCallback = (event: ToolProgressEvent) => void;

export function buildInitialDashboard(): AgentExecutionState[] {
  return agentCatalog.map((agent) => ({
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    currentTask: "Waiting for orchestration",
    status: "pending",
    progress: 0,
    dependencies: agent.dependencies,
    thinking: "Awaiting dependencies",
  }));
}

export async function executeTask(
  projectId: string,
  task: AgentTask,
  dashboard: AgentExecutionState[],
  onProgress?: TaskProgressCallback,
  onToolProgress?: ToolProgressCallback,
): Promise<AgentTask> {
  const agent = agentCatalog.find((item) => item.id === task.agentId);
  if (!agent) {
    throw new Error(`Agent ${task.agentId} not found.`);
  }

  const dashboardEntry = dashboard.find((entry) => entry.agentId === task.agentId);

  function updateState(patch: Partial<AgentExecutionState>) {
    if (!dashboardEntry) return;
    Object.assign(dashboardEntry, patch);
    onProgress?.({ ...dashboardEntry });
  }

  function emitToolProgress(event: ToolProgressEvent) {
    onToolProgress?.(event);
  }

  const globalMemory = getGlobalMemory(projectId);
  const localMemory = getLocalMemory(projectId, task.agentId);

  const context = [
    `Project goals: ${globalMemory.goals.join("; ") || "none yet"}`,
    `Architecture decisions: ${globalMemory.architecture.join("; ") || "none yet"}`,
    `Coding standards: ${globalMemory.codingStandards.join("; ")}`,
    localMemory.notes.length > 0
      ? `Your prior notes: ${localMemory.notes.map((n) => n.note).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userMessage = `${task.input}\n\n---\nProject context:\n${context}`;

  updateState({
    status: "running",
    currentTask: task.title,
    progress: 20,
    thinking: `${agent.role} is reading the project context.`,
  });

  const systemPrompt = agentSystemPrompts[task.agentId];

  updateState({ progress: 40, thinking: `${agent.role} is analyzing requirements.` });

  const startedAt = new Date().toISOString();
  let output: string;
  let toolRecords: ToolCallRecord[] = [];
  let workspaceChanged = false;
  let requiresApproval = false;

  try {
    const requestId = `${task.agentId}-${startedAt}`;
    const toolContext = buildToolContext(projectId, task, requestId);
    const toolNames = getAgentToolPreset(task.agentId);
    const hasWriteTools = toolNames.includes("write_file");

    if (hasWriteTools) {
      const runtime = await getWorkspaceRuntime(projectId);
      const toolNames = getAgentToolPreset(task.agentId);
      const result = await runAgentWithTools({
        systemPrompt,
        userMessage,
        agentId: task.agentId,
        toolNames,
        context: toolContext,
        task,
        onToolProgress: emitToolProgress,
      });
      output = result.output;
      toolRecords = result.toolRecords;
      workspaceChanged = result.workspaceChanged;
      requiresApproval = result.requiresApproval;
    } else {
      output = await runAgentLLM(systemPrompt, userMessage);
    }
  } catch (err) {
    updateState({
      status: "failed",
      progress: 0,
      thinking: err instanceof Error ? err.message : "Unknown error.",
    });
    return { ...task, status: "failed", startedAt, finishedAt: new Date().toISOString() };
  }

  writeLocalNote(projectId, task.agentId, {
    note: `Completed '${task.title}'. Output length: ${output.length} chars. Tool calls: ${toolRecords.length}.`,
  });

  const finishedAt = new Date().toISOString();

  const finalStatus = requiresApproval ? "blocked" : "completed";
  const finalProgress = requiresApproval ? 80 : 100;
  const finalThinking = requiresApproval
    ? "Work paused - approval required for tool action."
    : "Work package completed and shared with Orchestrator.";

  updateState({
    status: finalStatus,
    progress: finalProgress,
    thinking: finalThinking,
  });

  return {
    ...task,
    status: finalStatus,
    output,
    confidence: 0.9,
    startedAt,
    finishedAt,
    toolRecords,
    workspaceChanged,
  };
}

function buildToolContext(projectId: string, task: AgentTask, requestId: string): ToolContext {
  return {
    projectId,
    workspaceRoot: process.cwd(),
    requestId,
    actorId: task.agentId,
    actorRole: "agent",
  };
}