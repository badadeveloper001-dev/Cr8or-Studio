import { nanoid } from "nanoid";

import { agentCatalog } from "@/lib/agents/catalog";
import { executeTask, buildInitialDashboard, TaskProgressCallback, ToolProgressCallback } from "@/lib/agents/executor";
import { appendGlobalMemory } from "@/lib/agents/memory";
import { scheduleParallelBatches } from "@/lib/agents/scheduler";
import {
  AgentId,
  AgentTask,
  AgentExecutionState,
  OrchestrationRequest,
  OrchestrationResult,
  ToolProgressEvent,
} from "@/lib/agents/types";

export type { TaskProgressCallback, ToolProgressCallback };
export type OrchestrationProgressEvent =
  | { type: "agent_update"; data: AgentExecutionState }
  | { type: "batch_complete"; batchIndex: number; total: number }
  | { type: "done"; result: OrchestrationResult }
  | { type: "error"; message: string }
  | { type: "tool_progress"; data: ToolProgressEvent };

interface DomainAgentMap {
  ui_frontend: AgentId[];
  backend_api: AgentId[];
  database: AgentId[];
  mobile: AgentId[];
  security_review: AgentId[];
  performance_review: AgentId[];
  quality_assurance: AgentId[];
  documentation: AgentId[];
  devops_review: AgentId[];
  architecture: AgentId[];
  product_planning: AgentId[];
}

const DOMAIN_AGENT_MAP: DomainAgentMap = {
  ui_frontend: ["frontend", "uiux"],
  backend_api: ["backend", "database"],
  database: ["database", "backend"],
  mobile: ["mobile"],
  security_review: ["security"],
  performance_review: ["performance"],
  quality_assurance: ["qa"],
  documentation: ["documentation"],
  devops_review: ["devops"],
  architecture: ["architect", "database", "uiux"],
  product_planning: ["product", "research"],
};

function detectDomains(prompt: string): (keyof DomainAgentMap)[] {
  const lower = prompt.toLowerCase();
  const domains: (keyof DomainAgentMap)[] = [];

  if (/(ui|frontend|component|page|screen|interface|client|react|next\.js|tailwind|shadcn)/.test(lower)) {
    domains.push("ui_frontend");
  }
  if (/(api|backend|server|endpoint|route|business logic|auth|service)/.test(lower)) {
    domains.push("backend_api");
  }
  if (/(database|schema|prisma|migration|query|sql|postgres)/.test(lower)) {
    domains.push("database");
  }
  if (/(mobile|ios|android|react native|flutter|swift|kotlin)/.test(lower)) {
    domains.push("mobile");
  }
  if (/(security|vulnerability|audit|owasp|auth|authorization|vulnerabilit)/.test(lower)) {
    domains.push("security_review");
  }
  if (/(performance|optimiz|slow|latency|cach|bundle|profil)/.test(lower)) {
    domains.push("performance_review");
  }
  if (/(test|qa|quality|unit test|integration test|e2e|playwright|cypress)/.test(lower)) {
    domains.push("quality_assurance");
  }
  if (/(document|readme|docs|changelog|guide|api doc)/.test(lower)) {
    domains.push("documentation");
  }
  if (/(deploy|ci\/cd|docker|vercel|infrastructure|pipeline)/.test(lower)) {
    domains.push("devops_review");
  }
  if (/(architect|design|system|scalab|structure|boundar)/.test(lower)) {
    domains.push("architecture");
  }
  if (/(plan|roadmap|strateg|requirement|story|backlog|sprint)/.test(lower)) {
    domains.push("product_planning");
  }

  // Default: if no specific domain detected, include architecture and product
  if (domains.length === 0) {
    domains.push("architecture", "product_planning");
  }

  return domains;
}

function createTasksForDomains(prompt: string, domains: (keyof DomainAgentMap)[]): AgentTask[] {
  const agentIds = new Set<AgentId>();
  
  for (const domain of domains) {
    for (const agentId of DOMAIN_AGENT_MAP[domain]) {
      agentIds.add(agentId);
    }
  }

  // Only include agents materially needed for the detected domains

  return Array.from(agentIds).map((agentId) => ({
    id: `${agentId}-${nanoid(6)}`,
    agentId,
    title: `${agentCatalog.find(a => a.id === agentId)?.name} Work Package`,
    input: prompt,
    dependsOn: [],
    status: "pending" as const,
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
    architecture: ["Domain-based specialist routing with dependency-aware DAG scheduling."],
  });

  const domains = detectDomains(request.prompt);
  const initialTasks = createTasksForDomains(request.prompt, domains);
  const linkedTasks = linkDependencies(initialTasks);
  const dashboard = buildInitialDashboard();
  const batches = scheduleParallelBatches(linkedTasks);

  const taskById = new Map(linkedTasks.map((task) => [task.id, task]));

  const onProgress: TaskProgressCallback = (state) => {
    onEvent?.({ type: "agent_update", data: state });
  };

  const onToolProgress: ToolProgressCallback = (event) => {
    onEvent?.({ type: "tool_progress", data: event });
  };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    await Promise.all(
      batch.map(async (task) => {
        const current = taskById.get(task.id);
        if (!current) return;
        const completed = await executeTask(request.projectId, current, dashboard, (state) => {
          onProgress?.(state);
        }, (event) => {
          onToolProgress?.(event);
        });
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
      "Master Orchestrator routed work to relevant specialists based on task domain and synthesized output.",
    timeline,
    dashboard,
    synthesis,
  };

  onEvent?.({ type: "done", result });
  return result;
}
