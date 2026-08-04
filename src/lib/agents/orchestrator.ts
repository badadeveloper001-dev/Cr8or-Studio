import { nanoid } from "nanoid";

import { agentCatalog } from "@/lib/agents/catalog";
import { executeTask, buildInitialDashboard, TaskProgressCallback } from "@/lib/agents/executor";
import { appendGlobalMemory } from "@/lib/agents/memory";
import { scheduleParallelBatches } from "@/lib/agents/scheduler";
import {
  AgentTask,
  AgentExecutionState,
  OrchestrationRequest,
  OrchestrationResult,
} from "@/lib/agents/types";

export type { TaskProgressCallback };
export type OrchestrationProgressEvent =
  | { type: "agent_update"; data: AgentExecutionState }
  | { type: "batch_complete"; batchIndex: number; total: number }
  | { type: "done"; result: OrchestrationResult }
  | { type: "error"; message: string };

function createTasks(prompt: string): AgentTask[] {
  return agentCatalog.map((agent) => ({
    id: `${agent.id}-${nanoid(6)}`,
    agentId: agent.id,
    title: `${agent.name} Work Package`,
    input: prompt,
    dependsOn: [],
    status: "pending",
  }));
}

function linkDependencies(tasks: AgentTask[]): AgentTask[] {
  const byAgentId = new Map(tasks.map((task) => [task.agentId, task.id]));

  return tasks.map((task) => {
    const agent = agentCatalog.find((candidate) => candidate.id === task.agentId);
    const dependsOn = (agent?.dependencies ?? [])
      .map((dependencyId) => byAgentId.get(dependencyId))
      .filter((id): id is string => Boolean(id));
    return { ...task, dependsOn };
  });
}

function summarizeByDomain(completed: AgentTask[]) {
  const outputByAgent = new Map(completed.map((task) => [task.agentId, task.output ?? ""]));
  return {
    requirements: [
      outputByAgent.get("product") ?? "",
      outputByAgent.get("research") ?? "",
    ].filter(Boolean),
    architecture: [
      outputByAgent.get("architect") ?? "",
      outputByAgent.get("database") ?? "",
      outputByAgent.get("uiux") ?? "",
    ].filter(Boolean),
    implementation: [
      outputByAgent.get("backend") ?? "",
      outputByAgent.get("frontend") ?? "",
      outputByAgent.get("mobile") ?? "",
    ].filter(Boolean),
    quality: [
      outputByAgent.get("qa") ?? "",
      outputByAgent.get("security") ?? "",
      outputByAgent.get("performance") ?? "",
    ].filter(Boolean),
    deployment: [outputByAgent.get("devops") ?? ""].filter(Boolean),
    docs: [outputByAgent.get("documentation") ?? ""].filter(Boolean),
  };
}

export async function orchestrate(
  request: OrchestrationRequest,
  onEvent?: (event: OrchestrationProgressEvent) => void,
): Promise<OrchestrationResult> {
  appendGlobalMemory(request.projectId, {
    goals: [request.prompt],
    architecture: ["Parallel-by-default orchestration with dependency-aware DAG scheduling."],
  });

  const initialTasks = createTasks(request.prompt);
  const linkedTasks = linkDependencies(initialTasks);
  const dashboard = buildInitialDashboard();
  const batches = scheduleParallelBatches(linkedTasks);

  const taskById = new Map(linkedTasks.map((task) => [task.id, task]));

  const onProgress: TaskProgressCallback = (state) => {
    onEvent?.({ type: "agent_update", data: state });
  };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    await Promise.all(
      batch.map(async (task) => {
        const current = taskById.get(task.id);
        if (!current) return;
        const completed = await executeTask(request.projectId, current, dashboard, onProgress);
        taskById.set(task.id, completed);
      }),
    );
    onEvent?.({ type: "batch_complete", batchIndex: i, total: batches.length });
  }

  const timeline = Array.from(taskById.values());
  const synthesis = summarizeByDomain(timeline);

  const result: OrchestrationResult = {
    requestId: nanoid(),
    projectId: request.projectId,
    prompt: request.prompt,
    summary:
      "Master Orchestrator distributed work across specialized agents in parallel batches and synthesized one unified output.",
    timeline,
    dashboard,
    synthesis,
  };

  onEvent?.({ type: "done", result });
  return result;
}
