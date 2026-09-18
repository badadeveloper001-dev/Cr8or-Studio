import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { redactText } from "@/lib/security/redaction";

const execAsync = promisify(exec);

export const WORKSPACE_ROOT = process.cwd();
export const PROJECTS_ROOT = path.join(WORKSPACE_ROOT, "projects");

export function sanitizeWorkspacePath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    return null;
  }
  return normalized;
}

export function resolveWorkspacePath(input: string): string | null {
  const safePath = sanitizeWorkspacePath(input);
  if (!safePath) {
    return null;
  }

  const absolutePath = path.resolve(WORKSPACE_ROOT, safePath);
  if (!absolutePath.startsWith(WORKSPACE_ROOT)) {
    return null;
  }

  return absolutePath;
}

export function getActiveProjectRoot(projectId?: string): string {
  if (!projectId || projectId === "cr8or-studio") {
    return WORKSPACE_ROOT;
  }
  const projectPath = path.join(PROJECTS_ROOT, projectId);
  return projectPath;
}

export function resolveProjectPath(projectId: string | undefined, input: string): string | null {
  const projectRoot = getActiveProjectRoot(projectId);
  const safePath = sanitizeWorkspacePath(input);
  if (!safePath) {
    return null;
  }

  const absolutePath = path.resolve(projectRoot, safePath);
  if (!absolutePath.startsWith(projectRoot)) {
    return null;
  }

  return absolutePath;
}

function resolveCommandForPlatform(command: string): string {
  if (process.platform === "win32" && command.startsWith("npm ")) {
    return command.replace(/^npm /, "npm.cmd ");
  }
  return command;
}

type RunShellOptions = {
  envOverrides?: Record<string, string | undefined>;
  redactValues?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function runShell(command: string, cwd: string, options?: RunShellOptions) {
  const env = {
    ...process.env,
    ...(options?.envOverrides ?? {}),
  };

  const resolvedCommand = resolveCommandForPlatform(command);

  const { stdout, stderr } = await execAsync(resolvedCommand, {
    cwd,
    env,
    timeout: options?.timeoutMs ?? 120000,
    maxBuffer: 1024 * 1024 * 4,
    signal: options?.signal,
  });

  return {
    stdout: redactText(stdout.trim(), options?.redactValues ?? []),
    stderr: redactText(stderr.trim(), options?.redactValues ?? []),
  };
}
