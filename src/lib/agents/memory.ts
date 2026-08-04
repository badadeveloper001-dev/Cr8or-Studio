import {
  AgentId,
  AgentLocalMemory,
  MemoryNote,
  SharedGlobalMemory,
} from "@/lib/agents/types";

const globalMemoryByProject = new Map<string, SharedGlobalMemory>();
const localMemoryByProject = new Map<string, Map<AgentId, AgentLocalMemory>>();

function getDefaultGlobalMemory(): SharedGlobalMemory {
  return {
    goals: [],
    architecture: [],
    codingStandards: [
      "Keep modules cohesive and independently testable.",
      "Default to secure-by-design interfaces.",
      "Prefer explicit contracts over implicit coupling.",
    ],
    userPreferences: [],
  };
}

export function getGlobalMemory(projectId: string): SharedGlobalMemory {
  const existing = globalMemoryByProject.get(projectId);
  if (existing) {
    return existing;
  }
  const initial = getDefaultGlobalMemory();
  globalMemoryByProject.set(projectId, initial);
  return initial;
}

export function appendGlobalMemory(
  projectId: string,
  patch: Partial<SharedGlobalMemory>,
): SharedGlobalMemory {
  const current = getGlobalMemory(projectId);
  const merged: SharedGlobalMemory = {
    goals: [...current.goals, ...(patch.goals ?? [])],
    architecture: [...current.architecture, ...(patch.architecture ?? [])],
    codingStandards: [...current.codingStandards, ...(patch.codingStandards ?? [])],
    userPreferences: [...current.userPreferences, ...(patch.userPreferences ?? [])],
  };
  globalMemoryByProject.set(projectId, merged);
  return merged;
}

export function getLocalMemory(projectId: string, agentId: AgentId): AgentLocalMemory {
  const projectBucket = localMemoryByProject.get(projectId) ?? new Map<AgentId, AgentLocalMemory>();
  localMemoryByProject.set(projectId, projectBucket);

  const existing = projectBucket.get(agentId);
  if (existing) {
    return existing;
  }

  const initial: AgentLocalMemory = {
    agentId,
    decisions: [],
    notes: [],
  };
  projectBucket.set(agentId, initial);
  return initial;
}

export function writeLocalNote(
  projectId: string,
  agentId: AgentId,
  note: Omit<MemoryNote, "at" | "sourceAgent">,
): AgentLocalMemory {
  const memory = getLocalMemory(projectId, agentId);
  const next: AgentLocalMemory = {
    ...memory,
    notes: [
      ...memory.notes,
      {
        at: new Date().toISOString(),
        note: note.note,
        sourceAgent: agentId,
      },
    ],
  };
  const projectBucket = localMemoryByProject.get(projectId);
  projectBucket?.set(agentId, next);
  return next;
}
