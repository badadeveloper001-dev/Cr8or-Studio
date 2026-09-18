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

export type ToolPermissionTier = "read-only" | "writer" | "reviewer" | "none";

export interface AgentDefinition {
  id: AgentId;
  name: string;
  role: string;
  responsibility: string;
  expertise: string[];
  dependencies: AgentId[];
  toolPermissionTier: ToolPermissionTier;
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

export interface ToolCallRecord {
  id: string;
  agentId: string;
  tool: string;
  paramsSummary: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  workspaceChanged: boolean;
  requiresApproval: boolean;
  error?: string;
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
  toolRecords?: ToolCallRecord[];
  workspaceChanged?: boolean;
}

export interface ToolProgressEvent {
  agentId: string;
  tool: string;
  label: string;
  status: "running" | "completed" | "failed" | "blocked";
  detail?: string;
  startedAt: string;
  finishedAt?: string;
  requiresApproval: boolean;
  workspaceChanged: boolean;
  approvalDetail?: {
    tool: string;
    paramsSummary: string;
    preview: string;
    reason: string;
  };
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
