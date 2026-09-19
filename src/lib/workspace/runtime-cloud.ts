import { Sandbox } from "@daytona/sdk";
import { DaytonaProvider } from "@/lib/workspace/providers/daytona";
import {
  WorkspaceMetadata,
  GitStatusResult,
  GitDiffResult,
  CommandResult,
  ValidatedCommandRequest,
} from "@/lib/workspace/runtime";

interface CloudWorkspaceConfig {
  id: string;
  projectId: string;
  provider: DaytonaProvider;
  providerWorkspaceId: string;
  repositoryUrl?: string;
  branch?: string;
  createdAt: Date;
}

function validatePath(
  _projectId: string,
  relPath: string,
): { ok: boolean; absolutePath?: string; error?: string } {
  const safePath = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!safePath || safePath.includes("..")) {
    return { ok: false, error: "Invalid path: traversal or empty path not allowed" };
  }
  return { ok: true, absolutePath: safePath };
}

function resolveCommandForPlatform(command: string): string {
  if (process.platform === "win32" && command.startsWith("npm ")) {
    return command.replace(/^npm /, "npm.cmd ");
  }
  return command;
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

  private provider: DaytonaProvider;
  private sandbox: Sandbox | null = null;
  private createdAt: Date;
  private config: CloudWorkspaceConfig;

  constructor(config: CloudWorkspaceConfig) {
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

  async readFile(relPath: string): Promise<{ content: string; bytes: number }> {
    const validation = validatePath(this.projectId, relPath);
    if (!validation.ok) {
      throw new Error(validation.error);
    }
    const fs = this.getFileSystem();
    const buffer = await fs.downloadFile(validation.absolutePath!);
    const content = buffer.toString("utf8");
    return { content, bytes: buffer.length };
  }

  async writeFile(relPath: string, content: string): Promise<{ bytes: number }> {
    const validation = validatePath(this.projectId, relPath);
    if (!validation.ok) {
      throw new Error(validation.error);
    }
    const fs = this.getFileSystem();
    const buffer = Buffer.from(content, "utf8");
    await fs.uploadFile(buffer, validation.absolutePath!);
    return { bytes: buffer.length };
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
      .filter((entry) => !entry.name.startsWith("."))
      .slice(0, 200)
      .map((entry): { name: string; type: "file" | "directory" } => ({
        name: entry.name,
        type: entry.isDir ? "directory" : "file",
      }));
  }

  async gitStatus(): Promise<GitStatusResult> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    const git = this.provider.getSandboxGit(this.sandbox);
    const status = await git.status("/workspace");
    const changedFiles = status.fileStatus.map((fs) => ({
      path: fs.name,
      status: `${fs.staging}${fs.worktree}`.trim() || "??",
    }));
    return {
      branch: status.currentBranch,
      changes: changedFiles.map((f) => `${f.status} ${f.path}`).join("\n"),
      changedFiles,
      changedCount: changedFiles.length,
    };
  }

  async gitDiff(relPath?: string, staged?: boolean): Promise<GitDiffResult> {
    const stagedFlag = staged ? "--staged " : "";
    const fileArg = relPath ? ` -- ${relPath}` : "";

    const [diffResult, stagedDiffResult] = await Promise.all([
      this.executeCommandInSandbox(`git diff ${stagedFlag}${fileArg}`),
      this.executeCommandInSandbox(`git diff --staged${fileArg}`),
    ]);

    return {
      diff: diffResult.stdout,
      stagedDiff: stagedDiffResult.stdout,
    };
  }

  private async executeCommandInSandbox(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    const proc = this.provider.getSandboxProcess(this.sandbox);
    const result = await proc.executeCommand(command, "/workspace");
    return {
      stdout: result.artifacts?.stdout ?? result.result,
      stderr: "",
      exitCode: result.exitCode,
    };
  }

  async runCommand(request: ValidatedCommandRequest): Promise<CommandResult> {
    const resolvedCommand = resolveCommandForPlatform(request.command);
    const result = await this.executeCommandInSandbox(resolvedCommand);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
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

export function createCloudWorkspaceRuntime(config: CloudWorkspaceConfig): CloudWorkspaceRuntime {
  return new CloudWorkspaceRuntime(config);
}
