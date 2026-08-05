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

  const { stdout, stderr } = await execAsync(command, {
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
