export type AgentStatus = "idle" | "pending" | "running" | "blocked" | "completed" | "failed";

export type AgentId =
  | "architect"
  | "product"
  | "backend"
  | "frontend"
  | "mobile"
  | "database"
  | "devops"
  | "qa"
  | "security"
  | "performance"
  | "documentation"
  | "uiux"
  | "research";

export interface AgentDefinition {
  id: AgentId;
  name: string;
  role: string;
  responsibility: string;
  expertise: string[];
  dependencies: AgentId[];
}

export interface OrchestrationRequest {
  prompt: string;
  projectId: string;
  context?: {
    openFiles?: string[];
    repository?: string;
    branch?: string;
  };
}

export interface MemoryNote {
  at: string;
  note: string;
  sourceAgent: AgentId;
}

export interface SharedGlobalMemory {
  goals: string[];
  architecture: string[];
  codingStandards: string[];
  userPreferences: string[];
}

export interface AgentLocalMemory {
  agentId: AgentId;
  decisions: string[];
  notes: MemoryNote[];
}

export interface AgentTask {
  id: string;
  agentId: AgentId;
  title: string;
  input: string;
  dependsOn: string[];
  status: AgentStatus;
  output?: string;
  confidence?: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface AgentExecutionState {
  agentId: AgentId;
  name: string;
  role: string;
  currentTask: string;
  status: AgentStatus;
  progress: number;
  dependencies: AgentId[];
  thinking: string;
}

export interface OrchestrationResult {
  requestId: string;
  projectId: string;
  prompt: string;
  summary: string;
  timeline: AgentTask[];
  dashboard: AgentExecutionState[];
  synthesis: {
    requirements: string[];
    architecture: string[];
    implementation: string[];
    quality: string[];
    deployment: string[];
    docs: string[];
  };
}
