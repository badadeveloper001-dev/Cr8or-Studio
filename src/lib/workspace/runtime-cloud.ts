import "server-only";

import path from "node:path";
import { cloudPath, CLOUD_REPOSITORY_ROOT, shellQuote } from "@/lib/workspace/cloud-path";
import { Sandbox } from "@daytona/sdk";
import { DaytonaProvider } from "@/lib/workspace/providers/daytona";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import { ExecutionAuthorizationError, revalidateExecutionAuthorization, type ExecutionAuthorizationContext, type ExecutionOperation } from "@/lib/security/execution-context";
import { privateCloudFileOperation, rejectPrivateCloudWrite } from "@/lib/workspace/private-cloud-files";
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
  authorization?: ExecutionAuthorizationContext;
}

async function updateWorkspaceMapping(projectId: string, providerWorkspaceId: string): Promise<void> {
  try {
    const { prisma } = await import("@/lib/db/prisma");
    await prisma.workspace.update({
      where: { projectId },
      data: {
        providerWorkspaceId,
        state: "ready",
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      },
    });
  } catch {
    console.error(`[cloud-runtime] Failed to persist recovered sandbox ID for project ${projectId}`);
  }
}

async function ensureRepoCloned(
  provider: DaytonaProvider,
  sandbox: Sandbox,
  repositoryUrl?: string,
  branch?: string,
): Promise<void> {
  if (!repositoryUrl) return;
  const git = provider.getSandboxGit(sandbox);
  try {
    await git.status(CLOUD_REPOSITORY_ROOT);
  } catch {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    await git.clone(repositoryUrl, CLOUD_REPOSITORY_ROOT, branch, undefined, token ? "x-access-token" : undefined, token);
  }
}

export class CloudWorkspaceRuntime {
  readonly type = "cloud" as const;
  readonly projectId: string;
  readonly capabilities = {
    preview: true,
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

  private isPrivate(): boolean {
    return Boolean(this.config.authorization) || getPrivateAuthMode() === "required";
  }

  private async authorize(operation: ExecutionOperation): Promise<void> {
    const authorization = this.config.authorization;
    await revalidateExecutionAuthorization(authorization, this.projectId, operation);
    if (authorization && (authorization.workspace.runtimeType !== "cloud" ||
      authorization.workspace.provider !== "daytona" ||
      authorization.workspace.providerWorkspaceId !== this.config.providerWorkspaceId ||
      (this.sandbox && this.sandbox.id !== authorization.workspace.providerWorkspaceId))) {
      throw new ExecutionAuthorizationError(403, "Workspace runtime does not match the authorized project.");
    }
  }

  async initialize(): Promise<void> {
    await this.authorize("read");
    if (this.isPrivate()) {
      // A read must never start, recreate, reclone, or remap a cloud workspace.
      // Only the registered provider identifier can select the sandbox.
      if (!this.config.providerWorkspaceId) throw new ExecutionAuthorizationError(503, "The registered workspace is unavailable.");
      const sandbox = await this.provider.getSandbox(this.config.providerWorkspaceId);
      await this.authorize("read");
      if (!sandbox || sandbox.id !== this.config.providerWorkspaceId || sandbox.state !== "started") {
        throw new ExecutionAuthorizationError(503, "The registered workspace must already be running.");
      }
      this.sandbox = sandbox;
      return;
    }
    if (!this.provider) return;

    // A. Try persisted providerWorkspaceId first
    if (this.config.providerWorkspaceId) {
      this.sandbox = await this.provider.getSandbox(this.config.providerWorkspaceId);
      if (this.sandbox) {
        await this.recoverSandboxState();
        return;
      }
      // Persisted ID is stale — fall through to name-based recovery
    }

    // B. Try finding sandbox by deterministic name (projectId)
    const byName = await this.provider.findSandboxByName(this.config.projectId);
    if (byName) {
      this.sandbox = byName;
      await this.recoverSandboxState();
      await updateWorkspaceMapping(this.config.projectId, byName.id);
      this.config.providerWorkspaceId = byName.id;
      await ensureRepoCloned(this.provider, this.sandbox, this.config.repositoryUrl, this.config.branch);
      return;
    }

    // C. No sandbox found by ID or name — create/recover one
    try {
      this.sandbox = await this.provider.ensureSandbox({ name: this.config.projectId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message === "RECREATE_NEEDED") {
        this.sandbox = await this.provider.createSandbox({ name: this.config.projectId });
      } else {
        throw new Error(`Cloud workspace sandbox was unavailable and could not be recovered: ${message || "unknown error"}`);
      }
    }
    await this.recoverSandboxState();
    await updateWorkspaceMapping(this.config.projectId, this.sandbox.id);
    this.config.providerWorkspaceId = this.sandbox.id;
    await ensureRepoCloned(this.provider, this.sandbox, this.config.repositoryUrl, this.config.branch);
  }

  private async recoverSandboxState(): Promise<void> {
    if (!this.sandbox) return;
    const state = this.sandbox.state;
    if (state === "stopped") {
      await this.sandbox.start(60);
      await this.sandbox.waitUntilStarted();
    } else if (state === "error" || state === "build_failed") {
      if (this.sandbox.recoverable) {
        await this.sandbox.delete();
        throw new Error("SANDBOX_RECREATE_NEEDED");
      }
      throw new Error(`Sandbox is in an unrecoverable state: ${state}`);
    } else if (state !== "started") {
      await this.sandbox.waitUntilStarted();
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

  private rejectUnsafeCommand(): void {
    if (this.isPrivate()) throw new ExecutionAuthorizationError(503, "Workspace commands require a contained execution environment.");
  }

  async readFile(relPath: string): Promise<{ content: string; bytes: number }> {
    await this.authorize("read");
    if (this.isPrivate()) {
      const result = await privateCloudFileOperation(this.getProcess(), "read", relPath);
      await this.authorize("read");
      return result;
    }
    const absolutePath = cloudPath(relPath);
    const fs = this.getFileSystem();
    const buffer = await fs.downloadFile(absolutePath);
    await this.authorize("read");
    const content = buffer.toString("utf8");
    return { content, bytes: buffer.length };
  }

  async writeFile(relPath: string, content: string): Promise<{ bytes: number }> {
    await this.authorize("write");
    if (this.isPrivate()) {
      // Authorization still precedes the staging restriction. Never pass file
      // contents to command arguments or a pathname-only upload fallback.
      rejectPrivateCloudWrite(content);
    }
    const absolutePath = cloudPath(relPath);
    const fs = this.getFileSystem();
    await fs.createFolder(path.posix.dirname(absolutePath), "755");
    const buffer = Buffer.from(content, "utf8");
    await fs.uploadFile(buffer, absolutePath);
    await this.authorize("write");
    return { bytes: buffer.length };
  }

  async listFiles(relPath?: string): Promise<Array<{ name: string; type: "file" | "directory" }>> {
    await this.authorize("read");
    const targetPath = relPath ?? ".";
    if (this.isPrivate()) {
      const result = await privateCloudFileOperation(this.getProcess(), "list", targetPath);
      await this.authorize("read");
      return result;
    }
    const absolutePath = cloudPath(targetPath);
    const fs = this.getFileSystem();
    const files = await fs.listFiles(absolutePath);
    await this.authorize("read");
    return files
      .filter((entry) => !entry.name.startsWith("."))
      .slice(0, 200)
      .map((entry): { name: string; type: "file" | "directory" } => ({
        name: entry.name,
        type: entry.isDir ? "directory" : "file",
      }));
  }

  async gitStatus(): Promise<GitStatusResult> {
    await this.authorize("read");
    this.rejectUnsafeCommand();
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    const git = this.provider.getSandboxGit(this.sandbox);
    const status = await git.status(CLOUD_REPOSITORY_ROOT);
    await this.authorize("read");
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
    await this.authorize("read");
    this.rejectUnsafeCommand();
    const stagedFlag = staged ? "--staged " : "";
    const fileArg = relPath ? ` -- ${shellQuote(cloudPath(relPath))}` : "";

    const diffResult = await this.executeCommandInSandbox(`git diff ${stagedFlag}${fileArg}`, "read");
    const stagedDiffResult = await this.executeCommandInSandbox(`git diff --staged${fileArg}`, "read");

    return {
      diff: diffResult.stdout,
      stagedDiff: stagedDiffResult.stdout,
    };
  }

  private async executeCommandInSandbox(command: string, operation: "read" | "command" = "command"): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.authorize(operation);
    this.rejectUnsafeCommand();
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    const proc = this.provider.getSandboxProcess(this.sandbox);
    const result = await proc.executeCommand(command, CLOUD_REPOSITORY_ROOT);
    await this.authorize(operation);
    return {
      stdout: result.artifacts?.stdout ?? result.result,
      stderr: "",
      exitCode: result.exitCode,
    };
  }

  async runCommand(request: ValidatedCommandRequest): Promise<CommandResult> {
    const result = await this.executeCommandInSandbox(request.command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  async getMetadata(): Promise<WorkspaceMetadata> {
    await this.authorize("read");
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
