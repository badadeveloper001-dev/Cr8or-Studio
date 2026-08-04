import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

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

export async function runShell(command: string, cwd: string) {
  const { stdout, stderr } = await execAsync(command, {
    cwd,
    env: process.env,
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 4,
  });

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}
