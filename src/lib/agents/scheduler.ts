import { AgentTask } from "@/lib/agents/types";

export function scheduleParallelBatches(tasks: AgentTask[]): AgentTask[][] {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(task.id, task.dependsOn.length);
    adjacency.set(task.id, []);
  }

  for (const task of tasks) {
    for (const parentId of task.dependsOn) {
      const branch = adjacency.get(parentId);
      if (branch) {
        branch.push(task.id);
      }
    }
  }

  const batches: AgentTask[][] = [];
  let frontier = tasks.filter((task) => (inDegree.get(task.id) ?? 0) === 0).map((task) => task.id);

  while (frontier.length > 0) {
    const batch = frontier.map((id) => taskMap.get(id)).filter((task): task is AgentTask => Boolean(task));
    batches.push(batch);

    const nextFrontier: string[] = [];
    for (const taskId of frontier) {
      const children = adjacency.get(taskId) ?? [];
      for (const childId of children) {
        const next = (inDegree.get(childId) ?? 1) - 1;
        inDegree.set(childId, next);
        if (next === 0) {
          nextFrontier.push(childId);
        }
      }
    }
    frontier = nextFrontier;
  }

  const scheduledCount = batches.flat().length;
  if (scheduledCount !== tasks.length) {
    throw new Error("Invalid agent dependency graph: cycle detected.");
  }

  return batches;
}
