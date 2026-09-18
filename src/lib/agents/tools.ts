import { z } from "zod";
import { RiskAction } from "@/lib/security/policy";
import { AgentId } from "@/lib/agents/types";

export type ToolName =
  | "read_file"
  | "list_files"
  | "write_file"
  | "git_status"
  | "git_diff"
  | "run_command";

export const ToolRiskLevel = {
  low: "low" as const,
  medium: "medium" as const,
  high: "high" as const,
} as const;

export type ToolRisk = (typeof ToolRiskLevel)[keyof typeof ToolRiskLevel];

export interface ToolMetadata {
  name: ToolName;
  description: string;
  risk: ToolRisk;
  mutating: boolean;
  policyAction?: RiskAction;
  requiresWorkspace: boolean;
}

export interface ToolParameterSchema {
  [tool: string]: z.ZodSchema<unknown>;
}

export interface ToolContext {
  projectId: string;
  workspaceRoot: string;
  requestId: string;
  actorId: string;
  actorRole: string;
  approvalId?: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  tool: ToolName;
  data?: T;
  error?: string;
  requiresApproval?: boolean;
  workspaceChanged: boolean;
  startedAt: string;
  finishedAt: string;
}

export type ToolExecutorFn<TParams, TResult> = (
  params: TParams,
  context: ToolContext
) => Promise<ToolResult<TResult>>;

export interface ToolDefinition<TParams = unknown, TResult = unknown> {
  metadata: ToolMetadata;
  parameters: z.ZodSchema<TParams>;
  execute: ToolExecutorFn<TParams, TResult>;
}

const readFileParams = z.object({
  path: z.string().min(1),
});

const listFilesParams = z.object({
  path: z.string().optional(),
});

const writeFileParams = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const gitStatusParams = z.object({});

const gitDiffParams = z.object({
  path: z.string().optional(),
  staged: z.boolean().optional(),
});

const runCommandParams = z.object({
  command: z.string().min(1),
});

export const toolParameterSchemas: Record<ToolName, z.ZodSchema<unknown>> = {
  read_file: readFileParams,
  list_files: listFilesParams,
  write_file: writeFileParams,
  git_status: gitStatusParams,
  git_diff: gitDiffParams,
  run_command: runCommandParams,
};

export const toolMetadata: Record<ToolName, ToolMetadata> = {
  read_file: {
    name: "read_file",
    description: "Read the contents of a file in the workspace",
    risk: ToolRiskLevel.low,
    mutating: false,
    requiresWorkspace: true,
  },
  list_files: {
    name: "list_files",
    description: "List files in a directory (non-recursive, depth-limited)",
    risk: ToolRiskLevel.low,
    mutating: false,
    requiresWorkspace: true,
  },
  write_file: {
    name: "write_file",
    description: "Write content to a file in the workspace",
    risk: ToolRiskLevel.medium,
    mutating: true,
    policyAction: "files.write",
    requiresWorkspace: true,
  },
  git_status: {
    name: "git_status",
    description: "Get the current git status of the workspace",
    risk: ToolRiskLevel.low,
    mutating: false,
    requiresWorkspace: true,
  },
  git_diff: {
    name: "git_diff",
    description: "Get git diff for a file or the working tree",
    risk: ToolRiskLevel.low,
    mutating: false,
    requiresWorkspace: true,
  },
  run_command: {
    name: "run_command",
    description: "Run a validated command from the server-owned catalog",
    risk: ToolRiskLevel.medium,
    mutating: false,
    policyAction: "files.write",
    requiresWorkspace: true,
  },
};

export const ALL_TOOLS: ToolName[] = [
  "read_file",
  "list_files",
  "write_file",
  "git_status",
  "git_diff",
  "run_command",
];

export function getToolMetadata(name: ToolName): ToolMetadata {
  return toolMetadata[name];
}

export function getToolParameterSchema(name: ToolName): z.ZodSchema<unknown> {
  return toolParameterSchemas[name];
}

export function createToolSet(toolNames: ToolName[]): ToolName[] {
  return toolNames.filter((name) => name in toolMetadata);
}

export const AGENT_TOOL_PRESETS = {
  none: [] as ToolName[],
  read_only: ["read_file", "list_files", "git_status", "git_diff"] as ToolName[],
  reviewer: ["read_file", "list_files", "git_status", "git_diff"] as ToolName[],
  writer: ["read_file", "list_files", "write_file", "git_status", "git_diff", "run_command"] as ToolName[],
} as const;

export type ToolPermissionTier = "none" | "read-only" | "reviewer" | "writer";

export type AgentToolPreset = keyof typeof AGENT_TOOL_PRESETS;

export const AGENT_TOOL_TIER_MAP: Record<AgentId, ToolPermissionTier> = {
  product: "read-only",
  research: "read-only",
  architect: "read-only",
  uiux: "read-only",
  database: "writer",
  backend: "writer",
  frontend: "writer",
  mobile: "writer",
  security: "reviewer",
  performance: "reviewer",
  qa: "reviewer",
  documentation: "writer",
  devops: "reviewer",
} as const;

export function getAgentToolPreset(agentId: AgentId): ToolName[] {
  const tier = AGENT_TOOL_TIER_MAP[agentId];
  const preset = AGENT_TOOL_PRESETS[tier as keyof typeof AGENT_TOOL_PRESETS] ?? AGENT_TOOL_PRESETS.none;
  return preset;
}