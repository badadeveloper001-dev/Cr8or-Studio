import "server-only";

import { ExecutionAuthorizationContext, ExecutionAuthorizationError, revalidateExecutionAuthorization } from "@/lib/security/execution-context";
import { agentCatalog } from "@/lib/agents/catalog";
import { runAgentLLM } from "@/lib/agents/llm";
import { runAgentWithTools, getAgentToolPreset } from "@/lib/agents/tool-loop";
import { getGlobalMemory, getLocalMemory, writeLocalNote } from "@/lib/agents/memory";
import { agentSystemPrompts } from "@/lib/agents/prompts";
import { AgentExecutionState, AgentTask, ToolCallRecord, ToolProgressEvent } from "@/lib/agents/types";
import { ToolContext } from "@/lib/agents/tools";
import { redactText } from "@/lib/security/redaction";

export type TaskProgressCallback = (state: AgentExecutionState) => void | Promise<void>;
export type ToolProgressCallback = (event: ToolProgressEvent) => void | Promise<void>;

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
  authorization?: ExecutionAuthorizationContext,
): Promise<AgentTask> {
  await revalidateExecutionAuthorization(authorization, projectId, "memory");
  const agent = agentCatalog.find((item) => item.id === task.agentId);
  if (!agent) {
    throw new Error(`Agent ${task.agentId} not found.`);
  }

  const dashboardEntry = dashboard.find((entry) => entry.agentId === task.agentId);

  async function updateState(patch: Partial<AgentExecutionState>) {
    await revalidateExecutionAuthorization(authorization, projectId, "read");
    if (!dashboardEntry) return;
    Object.assign(dashboardEntry, patch);
    await onProgress?.({ ...dashboardEntry });
  }

  async function emitToolProgress(event: ToolProgressEvent) {
    await revalidateExecutionAuthorization(authorization, projectId, "read");
    await onToolProgress?.(event);
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

  await updateState({
    status: "running",
    currentTask: task.title,
    progress: 20,
    thinking: `${agent.role} is reading the project context.`,
  });

  const systemPrompt = agentSystemPrompts[task.agentId];

  await updateState({ progress: 40, thinking: `${agent.role} is analyzing requirements.` });

  const startedAt = new Date().toISOString();
  let output: string;
  let toolRecords: ToolCallRecord[] = [];
  let workspaceChanged = false;
  let requiresApproval = false;
  let failed = false;

  try {
    const requestId = `${task.agentId}-${startedAt}`;
    const toolContext = buildToolContext(projectId, task, requestId, authorization);
    const toolNames = getAgentToolPreset(task.agentId);

    if (toolNames.length > 0) {
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
      failed = result.failed ?? false;
    } else {
      output = await runAgentLLM(systemPrompt, userMessage, undefined, [], { authorization, projectId });
    }
  } catch (err) {
    if (err instanceof ExecutionAuthorizationError) throw err;
    await revalidateExecutionAuthorization(authorization, projectId, "read");
    const errorMessage = redactText(err instanceof Error ? err.message : "Unknown error");
    await updateState({
      status: "failed",
      progress: 0,
      thinking: errorMessage,
    });
    return {
      ...task,
      status: "failed",
      output: `Task failed: ${errorMessage}`,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  await revalidateExecutionAuthorization(authorization, projectId, "memory");
  writeLocalNote(projectId, task.agentId, {
    note: `${failed ? "Failed" : requiresApproval ? "Blocked" : "Completed"} '${task.title}'. Output length: ${output.length} chars. Tool calls: ${toolRecords.length}.`,
  });

  const finishedAt = new Date().toISOString();

  const finalStatus = failed ? "failed" : requiresApproval ? "blocked" : "completed";
  const finalProgress = failed ? 0 : requiresApproval ? 80 : 100;
  const finalThinking = failed ? "The task could not finish. See its output for details." : requiresApproval
    ? "Work paused - approval required for tool action."
    : "Work package completed and shared with Orchestrator.";

  await updateState({
    status: finalStatus,
    progress: finalProgress,
    thinking: finalThinking,
  });

  return {
    ...task,
    status: finalStatus,
    output,
    confidence: failed ? 0 : 0.9,
    startedAt,
    finishedAt,
    toolRecords,
    workspaceChanged,
  };
}

function buildToolContext(projectId: string, task: AgentTask, requestId: string, authorization?: ExecutionAuthorizationContext): ToolContext {
  return Object.freeze({
    projectId,
    workspaceRoot: process.cwd(),
    requestId,
    actorId: task.agentId,
    actorRole: "agent",
    authorization,
  });
}
