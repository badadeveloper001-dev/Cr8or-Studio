import { Daytona, Sandbox, FileSystem, Process, Git, CreateSandboxFromSnapshotParams } from "@daytona/sdk";
import type { SandboxState } from "@daytona/api-client";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { WorkspaceMetadata } from "@/lib/workspace/runtime";

interface DaytonaProviderConfig {
  apiKey: string;
  apiUrl?: string;
  target?: string;
}

interface DaytonaSandboxConfig {
  id?: string;
  name: string;
  user?: string;
  gitProvider?: "github" | "gitlab" | "bitbucket";
  gitRepo?: string;
  gitBranch?: string;
  envVars?: Record<string, string>;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  ephemeral?: boolean;
  labels?: Record<string, string>;
}

const DEFAULT_SANDBOX_CONFIG: CreateSandboxFromSnapshotParams = {
  user: "daytona",
  autoStopInterval: 15,
  autoDeleteInterval: 0,
  ephemeral: false,
};

export class DaytonaProvider {
  private client: Daytona;
  private privateFileClient: Daytona | undefined;
  private config: DaytonaProviderConfig;

  constructor(config: DaytonaProviderConfig) {
    this.config = config;
    this.client = new Daytona({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
    });
  }

  async createSandbox(config: DaytonaSandboxConfig): Promise<Sandbox> {
    const sandboxConfig: CreateSandboxFromSnapshotParams = {
      ...DEFAULT_SANDBOX_CONFIG,
      ...config,
      user: config.user || DEFAULT_SANDBOX_CONFIG.user,
      autoStopInterval: config.autoStopInterval ?? DEFAULT_SANDBOX_CONFIG.autoStopInterval,
      autoDeleteInterval: config.autoDeleteInterval ?? DEFAULT_SANDBOX_CONFIG.autoDeleteInterval,
    };

    const sandbox = await this.client.create(sandboxConfig);
    await sandbox.waitUntilStarted();
    return sandbox;
  }

  async getSandbox(id: string): Promise<Sandbox | null> {
    try {
      return await this.client.get(id);
    } catch {
      return null;
    }
  }

  async deleteSandbox(id: string): Promise<void> {
    const sandbox = await this.client.get(id);
    if (sandbox) {
      await sandbox.delete();
    }
  }

  async listSandboxes(): Promise<Sandbox[]> {
    const sandboxes: Sandbox[] = [];
    for await (const sandbox of this.client.list()) {
      sandboxes.push(sandbox);
    }
    return sandboxes;
  }

  async findSandboxByName(name: string): Promise<Sandbox | null> {
    for await (const sandbox of this.client.list({ name })) {
      if (sandbox.name === name) {
        await sandbox.refreshData();
        return sandbox;
      }
    }
    return null;
  }

  async ensureSandbox(config: DaytonaSandboxConfig): Promise<Sandbox> {
    const existing = await this.findSandboxByName(config.name);
    if (existing) {
      return this.recoverSandbox(existing);
    }

    try {
      const sandbox = await this.createSandbox(config);
      return sandbox;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("already exists")) {
        throw error;
      }
      const retry = await this.findSandboxByName(config.name);
      if (!retry) {
        throw error;
      }
      return this.recoverSandbox(retry);
    }
  }

  private async recoverSandbox(sandbox: Sandbox): Promise<Sandbox> {
    const state = sandbox.state as SandboxState | undefined;
    switch (state) {
      case "started":
        return sandbox;
      case "starting":
        await sandbox.waitUntilStarted();
        return sandbox;
      case "stopped":
        await sandbox.start(60);
        await sandbox.waitUntilStarted();
        return sandbox;
      case "error":
      case "build_failed":
        if (sandbox.recoverable) {
          await sandbox.delete();
          throw new Error("RECREATE_NEEDED");
        }
        throw new Error(`Sandbox is in an unrecoverable state: ${state}`);
      default:
        await sandbox.waitUntilStarted();
        return sandbox;
    }
  }

  getSandboxFileSystem(sandbox: Sandbox): FileSystem {
    return sandbox.fs;
  }

  getSandboxProcess(sandbox: Sandbox): Process {
    return sandbox.process;
  }

  /**
   * A separate client bounds private file-session HTTP calls without changing
   * existing runtime behavior. Callers must authorize before retrieval and
   * again before input/commit; this transport client caches no authorization.
   */
  async getPrivateFileSessionProcess(providerWorkspaceId: string): Promise<Process> {
    const unavailable = () => new ExecutionAuthorizationError(503, "The registered workspace is unavailable.");
    if (typeof providerWorkspaceId !== "string" || !providerWorkspaceId.trim() ||
        providerWorkspaceId.length > 256 || Buffer.byteLength(providerWorkspaceId, "utf8") > 256 ||
        providerWorkspaceId.includes("\0")) throw unavailable();
    try {
      this.privateFileClient ??= new Daytona({
        apiKey: this.config.apiKey,
        apiUrl: this.config.apiUrl,
        requestTimeoutMs: 5_000,
        // Session operations need no lifecycle event subscription. Avoid an
        // additional persistent event WebSocket for this scoped client.
        useDeprecatedPolling: true,
      });
      const sandbox = await this.privateFileClient.get(providerWorkspaceId);
      if (sandbox.id !== providerWorkspaceId || sandbox.state !== "started") throw unavailable();
      return sandbox.process;
    } catch {
      // Provider errors can contain request or execution details.
      throw unavailable();
    }
  }

  /** Read-only admission checks. These metadata checks are necessary but cannot
   * attest sandbox contents, peer processes, or immutable isolation; the command
   * release restriction remains closed. Never create/recover/reconfigure here. */
  async getPrivateCommandSessionProcess(providerWorkspaceId: string): Promise<Process> {
    const unavailable = () => new ExecutionAuthorizationError(503, "The registered command environment is unavailable.");
    if (typeof providerWorkspaceId !== "string" || !providerWorkspaceId.trim() ||
        Buffer.byteLength(providerWorkspaceId, "utf8") > 256 || providerWorkspaceId.includes("\0")) throw unavailable();
    try {
      this.privateFileClient ??= new Daytona({ apiKey: this.config.apiKey, apiUrl: this.config.apiUrl,
        requestTimeoutMs: 5_000, useDeprecatedPolling: true });
      const sandbox = await this.privateFileClient.get(providerWorkspaceId);
      if (sandbox.id !== providerWorkspaceId || sandbox.state !== "started" || sandbox.user !== "daytona" ||
          sandbox.public !== false || sandbox.networkBlockAll !== true || sandbox.linkedSandboxId ||
          sandbox.networkAllowList || sandbox.domainAllowList || sandbox.outboundProxyUrl ||
          !Array.isArray(sandbox.volumes) || sandbox.volumes.length !== 0 ||
          !sandbox.env || typeof sandbox.env !== "object" || Array.isArray(sandbox.env) || Object.keys(sandbox.env).length !== 0 ||
          sandbox.gpu !== 0 ||
          !Number.isFinite(sandbox.cpu) || sandbox.cpu <= 0 || sandbox.cpu > 2 ||
          !Number.isFinite(sandbox.memory) || sandbox.memory <= 0 || sandbox.memory > 4 ||
          !Number.isFinite(sandbox.disk) || sandbox.disk <= 0 || sandbox.disk > 10) throw unavailable();
      return sandbox.process;
    } catch { throw unavailable(); }
  }

  getSandboxGit(sandbox: Sandbox): Git {
    return sandbox.git;
  }

  /** Git may invoke project-controlled configuration even for reads. Reuse the
   * conservative command admission boundary; the independent Git gate stays shut. */
  async getPrivateGitSessionProcess(providerWorkspaceId: string): Promise<Process> {
    return this.getPrivateCommandSessionProcess(providerWorkspaceId);
  }

  async getSandboxMetadata(sandbox: Sandbox): Promise<WorkspaceMetadata> {
    return {
      id: sandbox.id,
      type: "cloud",
      projectId: "",
      capabilities: {
        preview: true,
        sleep: true,
        persistentStorage: true,
        gitSupport: true,
        nodeSupport: true,
      },
      state: "ready",
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };
  }
}

export function createDaytonaProvider(config: { apiKey: string; apiUrl?: string }): DaytonaProvider {
  return new DaytonaProvider(config);
}

export function validateDaytonaConfig(config: { apiKey?: string; apiUrl?: string }): { ok: boolean; error?: string } {
  if (!config.apiKey) {
    return { ok: false, error: "DAYTONA_API_KEY is required" };
  }
  return { ok: true };
}
