import { promises as fs } from "node:fs";
import path from "node:path";
import { DaytonaProvider } from "@/lib/workspace/providers/daytona";
import {
  WorkspaceRuntime,
  WorkspaceMetadata,
  WorkspaceCapabilities,
  GitStatusResult,
  GitDiffResult,
  CommandResult,
  ValidatedCommandRequest,
} from "@/lib/workspace/runtime";

interface CloudWorkspaceConfig {
  id: string;
  projectId: string;
  provider: "daytona";
  providerWorkspaceId: string;
  repositoryUrl?: string;
  branch?: string;
  createdAt: Date;
}

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
  const safePath = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!safePath || safePath.includes("..")) {
    return { ok: false, error: "Invalid path: traversal or empty path not allowed" };
  }
  // For cloud workspaces, paths are relative to workspace root (/workspace)
  return { ok: true, absolutePath: safePath };
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

export class CloudWorkspaceRuntime {
  readonly type = "cloud" as const;
  readonly projectId: string;
  readonly capabilities = {
    preview: false,
    sleep: true,
    persistentStorage: true,
    gitSupport: true,
    nodeSupport: true,
  } as const;
  readonly id: string;

  private provider: any;
  private sandbox: any;
  private createdAt: Date;
  private config: any;

  constructor(config: any) {
    this.config = config;
    this.projectId = config.projectId;
    this.id = config.id;
    this.provider = config.provider;
    this.createdAt = config.createdAt || new Date();
  }

  async initialize(): Promise<void> {
    if (this.provider && this.config.providerWorkspaceId) {
      this.sandbox = await this.provider.getSandbox(this.config.providerWorkspaceId);
      if (!this.sandbox) {
        throw new Error(`Sandbox not found: ${this.config.providerWorkspaceId}`);
      }
    }
  }

  private getFileSystem() {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    return this.provider.getSandboxFileSystem(this.sandbox);
  }

  private getProcess() {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    return this.provider.getSandboxProcess(this.sandbox);
  }

  private getGit() {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    return this.provider.getSandboxGit(this.sandbox);
  }

  async readFile(relPath: string): Promise<{ content: string; bytes: number }> {
    const validation = validatePath(this.projectId, relPath);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const fs = this.getFileSystem();
    const content = await fs.downloadFile(validation.absolutePath!);
    return { content, bytes: Buffer.byteLength(content, "utf8") };
  }

  async writeFile(relPath: string, content: string): Promise<{ bytes: number }> {
    const validation = validatePath(this.projectId, relPath);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const fs = this.getFileSystem();
    await fs.uploadFile({
      path: validation.absolutePath!,
      content: Buffer.from(content, "utf8"),
    });
    return { bytes: Buffer.byteLength(content, "utf8") };
  }

  async listFiles(relPath?: string): Promise<Array<{ name: string; type: "file" | "directory" }>> {
    const targetPath = relPath ?? ".";
    const validation = validatePath(this.projectId, targetPath);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const fs = this.getFileSystem();
    const files = await fs.listFiles(validation.absolutePath!);
    return files
      .filter((entry: any) => !entry.name.startsWith("."))
      .slice(0, 200)
      .map((entry: any): { name: string; type: "file" | "directory" } => ({
        name: entry.name,
        type: entry.isDirectory ? "directory" : "file",
      }));
  }

  async gitStatus(): Promise<GitStatusResult> {
    const git = this.getGit();
    const [statusResult, branchResult] = await Promise.all([
      this.runGitCommand("status --short"),
      this.runGitCommand("branch --show-current"),
    ]);

    const changes = statusResult.stdout;
    const changedFiles = parseChanges(changes);

    return {
      branch: branchResult.stdout.trim(),
      changes,
      changedFiles,
      changedCount: changedFiles.length,
    };
  }

  async gitDiff(relPath?: string, staged?: boolean): Promise<GitDiffResult> {
    const fileArg = relPath ? ` -- ${relPath}` : "";
    const stagedFlag = staged ? "--staged " : "";

    const [diffResult, stagedDiffResult] = await Promise.all([
      this.runGitCommand(`diff ${stagedFlag}${fileArg}`),
      this.runGitCommand(`diff --staged${fileArg}`),
    ]);

    return {
      diff: diffResult.stdout,
      stagedDiff: stagedDiffResult.stdout,
    };
  }

  private async runGitCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const process = this.provider.getSandboxProcess(this.sandbox);
    const resolvedCommand = `git ${command}`;
    const result = await this.executeCommandInSandbox(resolvedCommand);
    return result;
  }

  private async executeCommandInSandbox(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const process = this.provider.getSandboxProcess(this.sandbox);
    const result = await process.executeCommand({
      command,
      cwd: "/workspace",
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
    };
  }

  async runCommand(request: ValidatedCommandRequest): Promise<CommandResult> {
    const { command, rules, timeoutMs } = request;
    const resolvedCommand = resolveCommandForPlatform(command);
    
    // Translate rules for Windows platform as well
    const translatedRules = process.platform === "win32"
      ? request.rules.map(rule => {
          if (rule.kind === "exact" && rule.value.startsWith("npm ")) {
            return { kind: "exact" as const, value: rule.value.replace(/^npm /, "npm.cmd ") };
          }
          if (rule.kind === "prefix" && rule.value.startsWith("npm ")) {
            return { kind: "prefix" as const, value: rule.value.replace(/^npm /, "npm.cmd ") };
          }
          return rule;
        })
      : request.rules;

    const result = await this.executeCommandInSandbox(resolvedCommand);

    const exitCode = result.stderr && !result.stdout ? 1 : 0;
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    };
  }

  async getMetadata(): Promise<any> {
    return {
      id: this.id,
      type: this.type,
      projectId: this.projectId,
      capabilities: {
        preview: false,
        sleep: true,
        persistentStorage: true,
        gitSupport: true,
        nodeSupport: true,
      },
      state: "ready",
      createdAt: this.createdAt,
      lastActiveAt: new Date(),
    };
  }
}

export function createCloudWorkspaceRuntime(config: any): any {
  return new CloudWorkspaceRuntime(config);
}