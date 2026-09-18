import type { SandboxCommandRule } from "@/lib/security/sandbox";

export type WorkspaceRuntimeType = "local" | "cloud";

export interface WorkspaceCapabilities {
  preview: boolean;
  sleep: boolean;
  persistentStorage: boolean;
  gitSupport: boolean;
  nodeSupport: boolean;
}

export interface WorkspaceMetadata {
  id: string;
  type: WorkspaceRuntimeType;
  projectId: string;
  capabilities: WorkspaceCapabilities;
  state: "ready" | "running" | "error";
  createdAt: Date;
  lastActiveAt: Date;
}

export interface GitStatusResult {
  branch: string;
  changes: string;
  changedFiles: Array<{ path: string; status: string }>;
  changedCount: number;
}

export interface GitDiffResult {
  diff: string;
  stagedDiff: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ValidatedCommandRequest {
  command: string;
  commandKey: string;
  rules: readonly SandboxCommandRule[];
  timeoutMs?: number;
}

export interface WorkspaceRuntime {
  readonly id: string;
  readonly type: WorkspaceRuntimeType;
  readonly projectId: string;
  readonly capabilities: WorkspaceCapabilities;

  readFile(path: string): Promise<{ content: string; bytes: number }>;
  writeFile(path: string, content: string): Promise<{ bytes: number }>;
  listFiles(path?: string): Promise<Array<{ name: string; type: "file" | "directory" }>>;

  gitStatus(): Promise<GitStatusResult>;
  gitDiff(path?: string, staged?: boolean): Promise<GitDiffResult>;

  runCommand(request: ValidatedCommandRequest): Promise<CommandResult>;

  getMetadata(): Promise<WorkspaceMetadata>;
}