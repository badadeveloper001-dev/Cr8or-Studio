import { randomUUID } from "node:crypto";
import { generateText, dynamicTool, zodSchema } from "ai";
import { z } from "zod";

import { ToolName, ToolContext, toolMetadata, toolParameterSchemas, createToolSet, AGENT_TOOL_TIER_MAP, AGENT_TOOL_PRESETS, ToolPermissionTier } from "@/lib/agents/tools";
import { executeTool } from "@/lib/agents/tool-executor";
import { AgentTask, ToolCallRecord, ToolProgressEvent } from "@/lib/agents/types";
import { getModel } from "@/lib/agents/llm";

const MAX_TOOL_TURNS = 5;

export type ToolProgressCallback = (event: ToolProgressEvent) => void;

function formatToolsForPrompt(toolNames: ToolName[]): string {
  const lines = ["Available tools:"];
  for (const name of toolNames) {
    const metadata = toolMetadata[name];
    const schema = toolParameterSchemas[name];
    let paramKeys: string[] = [];
    try {
      const shape = (schema as unknown as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.();
      if (shape) {
        paramKeys = Object.keys(shape);
      }
    } catch {
      // ignore
    }
    lines.push(`- ${name}: ${metadata.description}`);
    if (paramKeys.length > 0) {
      lines.push(`  Parameters: ${paramKeys.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function formatToolCallRecord(record: ToolCallRecord): string {
  const status = record.ok ? "OK" : "ERROR";
  let summary = `[${record.tool}] ${status} (${record.finishedAt})`;
  if (!record.ok && record.error) {
    summary += ` - ${record.error}`;
  }
  if (record.requiresApproval) {
    summary += " - REQUIRES APPROVAL";
  }
  return summary;
}

function formatToolLabel(tool: string, paramsSummary: string): string {
  const toolLabels: Record<string, string> = {
    read_file: "Read",
    list_files: "List",
    write_file: "Edited",
    git_status: "Git status",
    git_diff: "Git diff",
    run_command: "Ran",
  };
  const label = toolLabels[tool] ?? tool;
  try {
    const params = JSON.parse(paramsSummary);
    if (params.path) return `${label} ${params.path}`;
    if (params.command) return `${label} ${params.command}`;
  } catch {
    // ignore
  }
  return label;
}

function buildToolReceiptsMessage(records: ToolCallRecord[]): string {
  if (records.length === 0) return "";
  const lines = ["\nTool execution history:"];
  for (const record of records) {
    lines.push(formatToolCallRecord(record));
  }
  return lines.join("\n");
}

function buildToolSchemasForModel(toolNames: ToolName[], context: ToolContext): Record<string, ReturnType<typeof dynamicTool>> {
  const schemas: Record<string, ReturnType<typeof dynamicTool>> = {};
  for (const name of toolNames) {
    const schema = toolParameterSchemas[name];
    const metadata = toolMetadata[name];
    schemas[name] = dynamicTool({
      description: metadata.description,
      inputSchema: zodSchema(schema as z.ZodSchema<unknown>),
      execute: async (params: unknown) => {
        const result = await executeTool(name, params, context);
        if (!result.ok) {
          throw new Error(result.error ?? "Tool execution failed");
        }
        return result.data;
      },
    });
  }
  return schemas;
}

export interface ToolLoopInput {
  systemPrompt: string;
  userMessage: string;
  agentId: string;
  toolNames: ToolName[];
  context: ToolContext;
  task: AgentTask;
  onToolProgress?: ToolProgressCallback;
}

export interface ToolLoopResult {
  output: string;
  toolRecords: ToolCallRecord[];
  workspaceChanged: boolean;
  requiresApproval: boolean;
  approvalDetail?: {
    tool: ToolName;
    paramsSummary: string;
    preview: string;
    reason: string;
  };
}

export async function runAgentWithTools(input: ToolLoopInput): Promise<ToolLoopResult> {
  const { systemPrompt, userMessage, agentId, toolNames, context, onToolProgress } = input;

  const toolRecords: ToolCallRecord[] = [];
  let workspaceChanged = false;
  let currentUserMessage = userMessage;
  let turnCount = 0;

  while (turnCount < MAX_TOOL_TURNS) {
    turnCount++;

    const model = getModel({ provider: "openai", model: "gpt-4o-mini", maxTokens: 4096 });

    const toolsPrompt = formatToolsForPrompt(toolNames);
    const receiptsMessage = buildToolReceiptsMessage(toolRecords);

    const fullSystemPrompt = `${systemPrompt}\n\n${toolsPrompt}\n\nRules:\n- Use tools only when the user actually asked for execution.\n- Conversational/brainstorming requests should not trigger file editing.\n- Inspect before editing.\n- Modify the smallest necessary files.\n- Do not rewrite unrelated code.\n- Validate after edits when appropriate.\n- Never commit or push.\n- Stop when approval is required.\n- Max ${MAX_TOOL_TURNS} tool turns.${receiptsMessage}`;

    const toolsForModel = buildToolSchemasForModel(toolNames, context);

    const { text, toolCalls } = await generateText({
      model,
      system: fullSystemPrompt,
      prompt: currentUserMessage,
      tools: toolsForModel,
      temperature: 0.2,
    });

    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const toolName = toolCall.toolName as ToolName;
        const startedAt = new Date().toISOString();

        const args = (toolCall as { args?: unknown; input?: unknown }).args ?? (toolCall as { args?: unknown; input?: unknown }).input ?? {};

        // Emit tool start event
        onToolProgress?.({
          agentId,
          tool: toolName,
          label: formatToolLabel(toolName, JSON.stringify(args).slice(0, 200)),
          status: "running",
          startedAt,
          requiresApproval: false,
          workspaceChanged: false,
        });

        const result = await executeTool(toolName, args, context);
        const finishedAt = new Date().toISOString();

        const paramsSummary = JSON.stringify(args).slice(0, 200);
        const record: ToolCallRecord = {
          id: randomUUID(),
          agentId,
          tool: toolName,
          paramsSummary,
          startedAt,
          finishedAt,
          ok: result.ok,
          workspaceChanged: result.workspaceChanged,
          requiresApproval: result.requiresApproval ?? false,
          error: result.error,
        };
        toolRecords.push(record);

        // Emit tool completion event
        onToolProgress?.({
          agentId,
          tool: toolName,
          label: formatToolLabel(toolName, paramsSummary),
          status: result.ok ? "completed" : (result.requiresApproval ? "blocked" : "failed"),
          detail: result.error,
          startedAt,
          finishedAt,
          requiresApproval: result.requiresApproval ?? false,
          workspaceChanged: result.workspaceChanged,
          approvalDetail: result.requiresApproval ? {
            tool: toolName,
            paramsSummary,
            preview: result.error ?? "Action requires approval",
            reason: "Policy requires approval for this action",
          } : undefined,
        });

        if (result.workspaceChanged) {
          workspaceChanged = true;
        }

        if (result.requiresApproval) {
          return {
            output: "",
            toolRecords,
            workspaceChanged,
            requiresApproval: true,
            approvalDetail: {
              tool: toolName,
              paramsSummary,
              preview: result.error ?? "Action requires approval",
              reason: "Policy requires approval for this action",
            },
          };
        }

        if (!result.ok) {
          currentUserMessage = `Tool ${toolName} failed: ${result.error}. Please analyze and decide next steps.`;
        } else {
          const dataSummary = result.data ? JSON.stringify(result.data).slice(0, 500) : "no data";
          currentUserMessage = `Tool ${toolName} succeeded. Result: ${dataSummary}. Continue with next steps or provide final answer.`;
        }
      }
    } else {
      return {
        output: text,
        toolRecords,
        workspaceChanged,
        requiresApproval: false,
      };
    }
  }

  return {
    output: "Max tool turns reached. Please provide a final answer based on the work done.",
    toolRecords,
    workspaceChanged,
    requiresApproval: false,
  };
}

export function getWriterToolPreset(): ToolName[] {
  return createToolSet(["read_file", "list_files", "write_file", "git_status", "git_diff", "run_command"]);
}

export function getDefaultToolPreset(): ToolName[] {
  return createToolSet(["read_file", "list_files", "git_status", "git_diff"]);
}

export function getAgentToolPreset(agentId: string): ToolName[] {
  const tier = AGENT_TOOL_TIER_MAP[agentId as keyof typeof AGENT_TOOL_TIER_MAP] as ToolPermissionTier | undefined;
  const preset = AGENT_TOOL_PRESETS[(tier as keyof typeof AGENT_TOOL_PRESETS) ?? "none"] ?? AGENT_TOOL_PRESETS.none;
  return preset;
}