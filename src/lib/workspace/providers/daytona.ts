import { Daytona, Sandbox, FileSystem, Process, Git, CreateSandboxFromSnapshotParams } from "@daytona/sdk";
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
