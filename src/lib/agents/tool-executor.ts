import { randomUUID } from "node:crypto";

import { evaluatePolicyGuard, RiskAction } from "@/lib/security/policy";
import { SandboxCommandRule } from "@/lib/security/sandbox";
import { appendAuditEvent } from "@/lib/security/audit";
import { ToolName, ToolContext, ToolResult, ToolMetadata, toolMetadata } from "@/lib/agents/tools";
import { getWorkspaceRuntime } from "@/lib/workspace/runtime-factory";

function getRuntime(context: ToolContext) {
  return getWorkspaceRuntime(context.projectId);
}

function createAuditMetadata(tool: ToolName, context: ToolContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool,
    workspaceId: context.projectId,
    requestId: context.requestId,
    actorId: context.actorId,
    actorRole: context.actorRole,
    ...extra,
  };
}

async function auditToolInvocation(
  tool: ToolName,
  context: ToolContext,
  outcome: "allow" | "deny" | "error",
  reason: string,
  metadata: Record<string, unknown> = {}
) {
  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: context.actorId,
    actorRole: context.actorRole,
    action: "tool.invoke",
    outcome,
    route: `tool/${tool}`,
    reason,
    requestId: context.requestId,
    metadata: createAuditMetadata(tool, context, metadata),
  });
}

async function checkPolicyIfNeeded(
  toolMeta: ToolMetadata,
  context: ToolContext
): Promise<{ allowed: boolean; requiresApproval: boolean; reason?: string; approvalConsumed?: boolean }> {
  if (!toolMeta.policyAction) {
    return { allowed: true, requiresApproval: false };
  }

  const policy = evaluatePolicyGuard({
    action: toolMeta.policyAction,
    requestId: context.requestId,
    actorId: context.actorId,
    actorRole: context.actorRole,
    approvalId: context.approvalId,
  });

  if (!policy.allowed) {
    return {
      allowed: false,
      requiresApproval: policy.approvalRequired,
      reason: policy.reason,
    };
  }

  return {
    allowed: true,
    requiresApproval: policy.approvalRequired,
    approvalConsumed: policy.approvalConsumed,
  };
}

type CommandCatalogEntry = {
  rules: SandboxCommandRule[];
  policyAction?: RiskAction;
  workspaceChanged: boolean;
  description: string;
};

const COMMAND_CATALOG: Record<string, CommandCatalogEntry> = {
  "npm run typecheck": {
    rules: [{ kind: "exact", value: "npm run typecheck" }],
    workspaceChanged: false,
    description: "Run TypeScript type checking",
  },
  "npm run lint": {
    rules: [{ kind: "exact", value: "npm run lint" }],
    workspaceChanged: false,
    description: "Run ESLint",
  },
  "npm test": {
    rules: [{ kind: "exact", value: "npm test" }],
    workspaceChanged: false,
    description: "Run all tests",
  },
  "npm run test:unit": {
    rules: [{ kind: "exact", value: "npm run test:unit" }],
    workspaceChanged: false,
    description: "Run unit tests",
  },
  "npm run test:integration": {
    rules: [{ kind: "exact", value: "npm run test:integration" }],
    workspaceChanged: false,
    description: "Run integration tests",
  },
};

function findCommandCatalogEntry(command: string): { key: string; entry: CommandCatalogEntry } | null {
  for (const [key, entry] of Object.entries(COMMAND_CATALOG)) {
    if (command === key) {
      return { key, entry };
    }
  }
  return null;
}

async function executeReadFile(params: { path: string }, context: ToolContext): Promise<ToolResult<{ content: string }>> {
  const startedAt = new Date().toISOString();
  const runtime = getRuntime(context);

  try {
    const result = await runtime.readFile(params.path);
    await auditToolInvocation("read_file", context, "allow", "file read", { path: params.path, bytes: result.bytes });
    return {
      ok: true,
      tool: "read_file",
      data: { content: result.content },
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read file";
    await auditToolInvocation("read_file", context, "error", message, { path: params.path });
    return {
      ok: false,
      tool: "read_file",
      error: message,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function executeListFiles(params: { path?: string }, context: ToolContext): Promise<ToolResult<{ files: Array<{ name: string; type: "file" | "directory" }> }>> {
  const startedAt = new Date().toISOString();
  const runtime = getRuntime(context);

  try {
    const files = await runtime.listFiles(params.path);
    await auditToolInvocation("list_files", context, "allow", "directory listed", { path: params.path ?? ".", count: files.length });
    return {
      ok: true,
      tool: "list_files",
      data: { files },
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list directory";
    await auditToolInvocation("list_files", context, "error", message, { path: params.path ?? "." });
    return {
      ok: false,
      tool: "list_files",
      error: message,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function executeWriteFile(params: { path: string; content: string }, context: ToolContext): Promise<ToolResult<{ bytes: number }>> {
  const startedAt = new Date().toISOString();
  const runtime = getRuntime(context);

  try {
    const result = await runtime.writeFile(params.path, params.content);
    await auditToolInvocation("write_file", context, "allow", "file written", { path: params.path, bytes: result.bytes });
    return {
      ok: true,
      tool: "write_file",
      data: { bytes: result.bytes },
      workspaceChanged: true,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to write file";
    await auditToolInvocation("write_file", context, "error", message, { path: params.path });
    return {
      ok: false,
      tool: "write_file",
      error: message,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function executeGitStatus(params: Record<string, never>, context: ToolContext): Promise<ToolResult<{ branch: string; changes: string; changedFiles: Array<{ path: string; status: string }>; changedCount: number }>> {
  const startedAt = new Date().toISOString();
  const runtime = getRuntime(context);

  try {
    const result = await runtime.gitStatus();
    await auditToolInvocation("git_status", context, "allow", "git status retrieved", { changedCount: result.changedCount });
    return {
      ok: true,
      tool: "git_status",
      data: result,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get git status";
    await auditToolInvocation("git_status", context, "error", message, {});
    return {
      ok: false,
      tool: "git_status",
      error: message,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function executeGitDiff(params: { path?: string; staged?: boolean }, context: ToolContext): Promise<ToolResult<{ diff: string; stagedDiff: string }>> {
  const startedAt = new Date().toISOString();
  const runtime = getRuntime(context);

  try {
    const result = await runtime.gitDiff(params.path, params.staged);
    await auditToolInvocation("git_diff", context, "allow", "git diff retrieved", { path: params.path ?? "all", staged: params.staged ?? false });
    return {
      ok: true,
      tool: "git_diff",
      data: result,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get git diff";
    await auditToolInvocation("git_diff", context, "error", message, {});
    return {
      ok: false,
      tool: "git_diff",
      error: message,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function executeRunCommand(params: { command: string }, context: ToolContext): Promise<ToolResult<{ stdout: string; stderr: string; exitCode: number }>> {
  const startedAt = new Date().toISOString();
  const runtime = getRuntime(context);
  const catalogEntry = findCommandCatalogEntry(params.command);

  if (!catalogEntry) {
    await auditToolInvocation("run_command", context, "deny", "Command not in allowed catalog", { command: params.command });
    return {
      ok: false,
      tool: "run_command",
      error: `Command not permitted. Allowed: ${Object.keys(COMMAND_CATALOG).join(", ")}`,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const { key, entry } = catalogEntry;

  const policy = await checkPolicyIfNeeded(toolMetadata.run_command, context);
  if (!policy.allowed) {
    await auditToolInvocation("run_command", context, "deny", policy.reason!, { command: key, requiresApproval: policy.requiresApproval });
    return {
      ok: false,
      tool: "run_command",
      error: policy.reason,
      requiresApproval: policy.requiresApproval,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  try {
    const validatedRequest = {
      command: key,
      commandKey: key,
      rules: entry.rules,
      timeoutMs: 120000,
    } as const;

    const result = await runtime.runCommand(validatedRequest);
    const exitCode = result.exitCode;
    await auditToolInvocation("run_command", context, "allow", "command executed", {
      command: key,
      exitCode,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
    });

    return {
      ok: true,
      tool: "run_command",
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode,
      },
      workspaceChanged: entry.workspaceChanged,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Command execution failed";
    await auditToolInvocation("run_command", context, "error", message, { command: key });
    return {
      ok: false,
      tool: "run_command",
      error: message,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

type ToolExecutor = (params: unknown, context: ToolContext) => Promise<ToolResult<unknown>>;

const toolExecutors: Record<ToolName, ToolExecutor> = {
  read_file: executeReadFile as ToolExecutor,
  list_files: executeListFiles as ToolExecutor,
  write_file: executeWriteFile as ToolExecutor,
  git_status: executeGitStatus as ToolExecutor,
  git_diff: executeGitDiff as ToolExecutor,
  run_command: executeRunCommand as ToolExecutor,
};

export async function executeTool(
  toolName: ToolName,
  params: unknown,
  context: ToolContext
): Promise<ToolResult<unknown>> {
  const executor = toolExecutors[toolName];
  if (!executor) {
    const startedAt = new Date().toISOString();
    return {
      ok: false,
      tool: toolName,
      error: `Unknown tool: ${toolName}`,
      workspaceChanged: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  return executor(params, context);
}

export function getAvailableCommands(): Array<{ command: string; description: string }> {
  return Object.entries(COMMAND_CATALOG).map(([command, entry]) => ({
    command,
    description: entry.description,
  }));
}

export function getCommandCatalog(): typeof COMMAND_CATALOG {
  return COMMAND_CATALOG;
}