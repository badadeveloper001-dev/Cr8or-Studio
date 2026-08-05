import { randomUUID } from "node:crypto";

import { appendAuditEvent } from "@/lib/security/audit";
import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { WORKSPACE_ROOT, runShell } from "@/lib/workspace/shell";

export type SandboxCommandRule =
  | { kind: "exact"; value: string }
  | { kind: "prefix"; value: string };

export type SandboxedCommandInput = {
  command: string;
  cwd: string;
  workspaceId: string;
  route: string;
  actorId: string;
  actorRole: string;
  requestId?: string;
  allowedRoots: string[];
  allowedCommands: SandboxCommandRule[];
  timeoutMs?: number;
  envOverrides?: Record<string, string | undefined>;
  redactValues?: string[];
};

type SandboxRuntimeStore = {
  activeByOperationId: Map<string, AbortController>;
  activeCountByWorkspace: Map<string, number>;
  usageWindowByWorkspace: Map<string, { startsAt: number; count: number }>;
};

export type SandboxRuntimeSnapshot = {
  sandboxEnabled: boolean;
  activeOperations: number;
  activeByWorkspace: Array<{ workspaceId: string; count: number }>;
  quotas: {
    maxConcurrentPerWorkspace: number;
    maxCommandsPerMinutePerWorkspace: number;
    defaultTimeoutMs: number;
  };
};

declare global {
  var __cr8orSandboxStore: SandboxRuntimeStore | undefined;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.CR8OR_SANDBOX_TIMEOUT_MS ?? 120000);
const MAX_CONCURRENT_PER_WORKSPACE = Number(process.env.CR8OR_SANDBOX_MAX_CONCURRENT ?? 2);
const MAX_COMMANDS_PER_MINUTE_PER_WORKSPACE = Number(process.env.CR8OR_SANDBOX_MAX_PER_MINUTE ?? 60);

function getStore(): SandboxRuntimeStore {
  if (!globalThis.__cr8orSandboxStore) {
    globalThis.__cr8orSandboxStore = {
      activeByOperationId: new Map(),
      activeCountByWorkspace: new Map(),
      usageWindowByWorkspace: new Map(),
    };
  }
  return globalThis.__cr8orSandboxStore;
}

function isWithinAllowedRoots(cwd: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

function matchesAllowedCommand(command: string, rules: SandboxCommandRule[]): boolean {
  return rules.some((rule) => {
    if (rule.kind === "exact") {
      return command === rule.value;
    }
    return command.startsWith(rule.value);
  });
}

function getCommandWindow(workspaceId: string): { startsAt: number; count: number } {
  const store = getStore();
  const now = Date.now();
  const existing = store.usageWindowByWorkspace.get(workspaceId);
  if (!existing || now - existing.startsAt >= 60_000) {
    const fresh = { startsAt: now, count: 0 };
    store.usageWindowByWorkspace.set(workspaceId, fresh);
    return fresh;
  }
  return existing;
}

function reserveCapacity(workspaceId: string): boolean {
  const store = getStore();
  const current = store.activeCountByWorkspace.get(workspaceId) ?? 0;
  if (current >= MAX_CONCURRENT_PER_WORKSPACE) {
    return false;
  }
  store.activeCountByWorkspace.set(workspaceId, current + 1);
  return true;
}

function releaseCapacity(workspaceId: string) {
  const store = getStore();
  const current = store.activeCountByWorkspace.get(workspaceId) ?? 0;
  const next = Math.max(0, current - 1);
  if (next === 0) {
    store.activeCountByWorkspace.delete(workspaceId);
  } else {
    store.activeCountByWorkspace.set(workspaceId, next);
  }
}

function registerCommandUsage(workspaceId: string): boolean {
  const window = getCommandWindow(workspaceId);
  if (window.count >= MAX_COMMANDS_PER_MINUTE_PER_WORKSPACE) {
    return false;
  }
  window.count += 1;
  return true;
}

export class SandboxViolationError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 403, code = "SANDBOX_VIOLATION") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function runSandboxedCommand(input: SandboxedCommandInput) {
  const sandboxEnabled = isFeatureEnabled("sandboxRuntime");

  const emitViolation = (reason: string, status: number, code: string) => {
    appendAuditEvent({
      id: randomUUID(),
      at: new Date().toISOString(),
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: "sandbox.violation",
      outcome: "deny",
      route: input.route,
      reason,
      requestId: input.requestId,
      metadata: {
        workspaceId: input.workspaceId,
        command: input.command,
        cwd: input.cwd,
        code,
      },
    });

    throw new SandboxViolationError(reason, status, code);
  };

  if (!input.cwd.startsWith(WORKSPACE_ROOT)) {
    emitViolation("Command cwd is outside workspace root.", 403, "SANDBOX_PATH_OUTSIDE_ROOT");
  }

  if (!isWithinAllowedRoots(input.cwd, input.allowedRoots)) {
    emitViolation("Command cwd is outside allowed route roots.", 403, "SANDBOX_PATH_NOT_ALLOWED");
  }

  if (!matchesAllowedCommand(input.command, input.allowedCommands)) {
    emitViolation("Command is not allowed for this route.", 403, "SANDBOX_COMMAND_NOT_ALLOWED");
  }

  if (sandboxEnabled) {
    if (!registerCommandUsage(input.workspaceId)) {
      emitViolation("Workspace command quota exceeded.", 429, "SANDBOX_QUOTA_EXCEEDED");
    }

    if (!reserveCapacity(input.workspaceId)) {
      emitViolation("Workspace concurrent command limit reached.", 429, "SANDBOX_CONCURRENCY_EXCEEDED");
    }
  }

  const operationId = randomUUID();
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const store = getStore();
  store.activeByOperationId.set(operationId, controller);

  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: "sandbox.run",
    outcome: "allow",
    route: input.route,
    reason: `started:${operationId}`,
    requestId: input.requestId,
    metadata: {
      workspaceId: input.workspaceId,
      command: input.command,
      cwd: input.cwd,
      sandboxEnabled,
      timeoutMs,
    },
  });

  try {
    const result = await runShell(input.command, input.cwd, {
      envOverrides: input.envOverrides,
      redactValues: input.redactValues,
      timeoutMs,
      signal: controller.signal,
    });

    return {
      operationId,
      ...result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox command execution failed.";
    const timedOut = controller.signal.aborted;

    appendAuditEvent({
      id: randomUUID(),
      at: new Date().toISOString(),
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: timedOut ? "sandbox.timeout" : "sandbox.run",
      outcome: "error",
      route: input.route,
      reason: message,
      requestId: input.requestId,
      metadata: {
        workspaceId: input.workspaceId,
        command: input.command,
        cwd: input.cwd,
        operationId,
      },
    });

    throw error;
  } finally {
    clearTimeout(timer);
    store.activeByOperationId.delete(operationId);
    if (sandboxEnabled) {
      releaseCapacity(input.workspaceId);
    }
  }
}

export function cancelSandboxOperation(operationId: string, actorId: string, actorRole: string): boolean {
  const store = getStore();
  const controller = store.activeByOperationId.get(operationId);
  if (!controller) {
    return false;
  }

  controller.abort();
  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId,
    actorRole,
    action: "sandbox.cancel",
    outcome: "allow",
    reason: `cancelled:${operationId}`,
    metadata: { operationId },
  });
  return true;
}

export function getSandboxRuntimeSnapshot(): SandboxRuntimeSnapshot {
  const store = getStore();
  return {
    sandboxEnabled: isFeatureEnabled("sandboxRuntime"),
    activeOperations: store.activeByOperationId.size,
    activeByWorkspace: [...store.activeCountByWorkspace.entries()].map(([workspaceId, count]) => ({ workspaceId, count })),
    quotas: {
      maxConcurrentPerWorkspace: MAX_CONCURRENT_PER_WORKSPACE,
      maxCommandsPerMinutePerWorkspace: MAX_COMMANDS_PER_MINUTE_PER_WORKSPACE,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    },
  };
}
