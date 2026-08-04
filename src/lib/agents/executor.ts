import { agentCatalog } from "@/lib/agents/catalog";
import { runAgentLLM } from "@/lib/agents/llm";
import { getGlobalMemory, getLocalMemory, writeLocalNote } from "@/lib/agents/memory";
import { agentSystemPrompts } from "@/lib/agents/prompts";
import { AgentExecutionState, AgentTask } from "@/lib/agents/types";

export type TaskProgressCallback = (state: AgentExecutionState) => void;

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

  try {
    output = await runAgentLLM(systemPrompt, userMessage);
  } catch (err) {
    updateState({
      status: "failed",
      progress: 0,
      thinking: err instanceof Error ? err.message : "Unknown error.",
    });
    return { ...task, status: "failed", startedAt, finishedAt: new Date().toISOString() };
  }

  writeLocalNote(projectId, task.agentId, {
    note: `Completed '${task.title}'. Output length: ${output.length} chars.`,
  });

  const finishedAt = new Date().toISOString();

  updateState({
    status: "completed",
    progress: 100,
    thinking: "Work package completed and shared with Orchestrator.",
  });

  return {
    ...task,
    status: "completed",
    output,
    confidence: 0.9,
    startedAt,
    finishedAt,
  };
}
