import { Daytona, Sandbox, FileSystem, Process, Git, CreateSandboxFromSnapshotParams } from "@daytona/sdk";
import type { SandboxState } from "@daytona/api-client";
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

  getSandboxGit(sandbox: Sandbox): Git {
    return sandbox.git;
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
