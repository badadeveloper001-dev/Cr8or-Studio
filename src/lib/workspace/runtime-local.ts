import { promises as fs } from "node:fs";
import path from "node:path";

import { sanitizeWorkspacePath, resolveProjectPath, getActiveProjectRoot } from "@/lib/workspace/shell";
import { runSandboxedCommand } from "@/lib/security/sandbox";
import { WorkspaceRuntime, WorkspaceMetadata, WorkspaceCapabilities, GitStatusResult, GitDiffResult, CommandResult, ValidatedCommandRequest } from "@/lib/workspace/runtime";

const SECRET_SENSITIVE_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  "secrets",
  ".secret",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  "credentials",
  "credential",
];

function isSecretSensitivePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").toLowerCase();
  return SECRET_SENSITIVE_PATHS.some((secret) => {
    if (secret.includes("*")) {
      const pattern = secret.replace(/\*/g, ".*");
      return new RegExp(`^${pattern}$`).test(normalized);
    }
    return normalized === secret || normalized.startsWith(`${secret}/`) || normalized.endsWith(`/${secret}`);
  });
}

function validatePath(projectId: string | undefined, relPath: string): { ok: boolean; absolutePath?: string; error?: string } {
  const safePath = sanitizeWorkspacePath(relPath);
  if (!safePath) {
    return { ok: false, error: "Invalid path: traversal or empty path not allowed" };
  }

  const absolutePath = resolveProjectPath(projectId, safePath);
  if (!absolutePath) {
    return { ok: false, error: "Path resolves outside project root" };
  }

  if (isSecretSensitivePath(safePath)) {
    return { ok: false, error: "Access to secret-sensitive paths is forbidden" };
  }

  return { ok: true, absolutePath };
}

function resolveCommandForPlatform(command: string): string {
  if (process.platform === "win32" && command.startsWith("npm ")) {
    return command.replace(/^npm /, "npm.cmd ");
  }
  return command;
}

function parseChanges(raw: string): Array<{ path: string; status: string }> {
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "?";
      const path = line.slice(3).trim();
      return { path, status };
    });
}

export class LocalWorkspaceRuntime implements WorkspaceRuntime {
  readonly type = "local" as const;
  readonly projectId: string;
  readonly capabilities: WorkspaceCapabilities = {
    preview: false,
    sleep: false,
    persistentStorage: true,
    gitSupport: true,
    nodeSupport: true,
  };
  readonly id: string;

  private projectRoot: string;
  private createdAt: Date;

  constructor(projectId: string) {
    this.projectId = projectId;
    this.id = `local-${projectId}`;
    this.projectRoot = getActiveProjectRoot(projectId);
    this.createdAt = new Date();
  }

  async readFile(relPath: string): Promise<{ content: string; bytes: number }> {
    const validation = validatePath(this.projectId, relPath);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const content = await fs.readFile(validation.absolutePath!, "utf8");
    return { content, bytes: Buffer.byteLength(content, "utf8") };
  }

  async writeFile(relPath: string, content: string): Promise<{ bytes: number }> {
    const validation = validatePath(this.projectId, relPath);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    await fs.mkdir(path.dirname(validation.absolutePath!), { recursive: true });
    await fs.writeFile(validation.absolutePath!, content, "utf8");
    return { bytes: Buffer.byteLength(content, "utf8") };
  }

  async listFiles(relPath?: string): Promise<Array<{ name: string; type: "file" | "directory" }>> {
    const targetPath = relPath ?? ".";
    const validation = validatePath(this.projectId, targetPath);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const entries = await fs.readdir(validation.absolutePath!, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .slice(0, 200)
      .map((entry): { name: string; type: "file" | "directory" } => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
  }

  async gitStatus(): Promise<GitStatusResult> {
    const result = await runSandboxedCommand({
      command: "git status --short",
      cwd: this.projectRoot,
      workspaceId: this.projectId,
      route: "runtime/git_status",
      actorId: "runtime",
      actorRole: "runtime",
      allowedRoots: [this.projectRoot],
      allowedCommands: [{ kind: "exact", value: "git status --short" }],
    });

    const branchResult = await runSandboxedCommand({
      command: "git branch --show-current",
      cwd: this.projectRoot,
      workspaceId: this.projectId,
      route: "runtime/git_status",
      actorId: "runtime",
      actorRole: "runtime",
      allowedRoots: [this.projectRoot],
      allowedCommands: [{ kind: "exact", value: "git branch --show-current" }],
    });

    const changes = result.stdout;
    const changedFiles = parseChanges(changes);

    return {
      branch: branchResult.stdout,
      changes,
      changedFiles,
      changedCount: changedFiles.length,
    };
  }

  async gitDiff(relPath?: string, staged?: boolean): Promise<GitDiffResult> {
    const fileArg = relPath ? ` -- ${relPath}` : "";
    const stagedFlag = staged ? "--staged " : "";

    const diffResult = await runSandboxedCommand({
      command: `git --no-pager diff ${stagedFlag}${fileArg}`,
      cwd: this.projectRoot,
      workspaceId: this.projectId,
      route: "runtime/git_diff",
      actorId: "runtime",
      actorRole: "runtime",
      allowedRoots: [this.projectRoot],
      allowedCommands: [{ kind: "prefix", value: "git --no-pager diff" }],
    });

    const stagedDiffResult = await runSandboxedCommand({
      command: `git --no-pager diff --staged${fileArg}`,
      cwd: this.projectRoot,
      workspaceId: this.projectId,
      route: "runtime/git_diff",
      actorId: "runtime",
      actorRole: "runtime",
      allowedRoots: [this.projectRoot],
      allowedCommands: [{ kind: "prefix", value: "git --no-pager diff --staged" }],
    });

    return {
      diff: diffResult.stdout,
      stagedDiff: stagedDiffResult.stdout,
    };
  }

  async runCommand(request: ValidatedCommandRequest): Promise<CommandResult> {
    const { command, rules, timeoutMs } = request;
    const resolvedCommand = resolveCommandForPlatform(command);
    
    // Translate rules for Windows platform as well
    const translatedRules = process.platform === "win32"
      ? rules.map(rule => {
          if (rule.kind === "exact" && rule.value.startsWith("npm ")) {
            return { kind: "exact" as const, value: rule.value.replace(/^npm /, "npm.cmd ") };
          }
          if (rule.kind === "prefix" && rule.value.startsWith("npm ")) {
            return { kind: "prefix" as const, value: rule.value.replace(/^npm /, "npm.cmd ") };
          }
          return rule;
        })
      : rules;

    const result = await runSandboxedCommand({
      command: resolvedCommand,
      cwd: this.projectRoot,
      workspaceId: this.projectId,
      route: "runtime/run_command",
      actorId: "runtime",
      actorRole: "runtime",
      allowedRoots: [this.projectRoot],
      allowedCommands: [...translatedRules],
      timeoutMs,
      redactValues: [],
    });

    const exitCode = result.stderr && !result.stdout ? 1 : 0;
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    };
  }

  async getMetadata(): Promise<WorkspaceMetadata> {
    return {
      id: this.id,
      type: this.type,
      projectId: this.projectId,
      capabilities: this.capabilities,
      state: "ready",
      createdAt: this.createdAt,
      lastActiveAt: new Date(),
    };
  }
}