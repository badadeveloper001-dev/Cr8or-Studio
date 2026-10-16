import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionAuthorizationContext } from "@/lib/security/execution-context";

const mocks = vi.hoisted(() => ({
  revalidate: vi.fn(), sandboxed: vi.fn(), workspace: vi.fn(), sandbox: vi.fn(),
}));
vi.mock("@/lib/security/execution-context", () => ({
  revalidateExecutionAuthorization: mocks.revalidate,
  ExecutionAuthorizationError: class extends Error {
    constructor(readonly status: number, message = "Execution not authorized.") { super(message); }
  },
}));
vi.mock("@/lib/security/sandbox", () => ({ runSandboxedCommand: mocks.sandboxed }));
vi.mock("@/lib/security/git-authorization", () => ({
  validateGitRepositoryContext: async (context: ExecutionAuthorizationContext) => mocks.revalidate(context, context.projectId, "read"),
  authorizeRuntimeGitRead: vi.fn(),
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { workspace: { findUnique: mocks.workspace } } }));
vi.mock("@/lib/workspace/providers/daytona", () => ({ DaytonaProvider: class {
  getSandbox = mocks.sandbox;
} }));

import { LocalWorkspaceRuntime } from "@/lib/workspace/runtime-local";
import { CloudWorkspaceRuntime } from "@/lib/workspace/runtime-cloud";
import { getWorkspaceRuntime } from "@/lib/workspace/runtime-factory";
import type { DaytonaProvider } from "@/lib/workspace/providers/daytona";

let projectId: string;
let projectRoot: string;
let outside: string;
let context: ExecutionAuthorizationContext;

function makeContext(cloud = false): ExecutionAuthorizationContext {
  return { ownerId: "owner", projectId, permissions: ["read", "write", "command"],
    signal: new AbortController().signal, workspace: { id: "workspace-row", runtimeType: cloud ? "cloud" : "local",
      provider: cloud ? "daytona" : null, providerWorkspaceId: cloud ? "historical-sandbox" : null,
      repositoryUrl: null, branch: null } } as unknown as ExecutionAuthorizationContext;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "true");
  vi.stubEnv("CR8OR_WORKSPACE_MODE", "local");
  vi.stubEnv("VERCEL_ENV", "");
  projectId = `runtime-test-${randomUUID()}`;
  projectRoot = path.join(process.cwd(), "projects", projectId);
  await fs.mkdir(projectRoot, { recursive: true });
  outside = await fs.mkdtemp(path.join(tmpdir(), "cr8or-runtime-outside-"));
  context = makeContext();
  mocks.revalidate.mockImplementation(async (candidate, id, permission) => {
    if (candidate !== context || id !== projectId || !context.permissions.includes(permission)) throw new Error("Authorization rejected");
  });
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("private local runtime boundary", () => {
  it("rejects raw factory and direct constructor operations before filesystem work", async () => {
    await expect(getWorkspaceRuntime(projectId)).rejects.toThrow("Authorization rejected");
    const runtime = new LocalWorkspaceRuntime(projectId);
    await expect(runtime.writeFile("created.txt", "no")).rejects.toThrow("Authorization rejected");
    await expect(fs.stat(path.join(projectRoot, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it("rejects a context bound to another project", async () => {
    await expect(getWorkspaceRuntime("another-project", context)).rejects.toThrow("Authorization rejected");
    await expect(new LocalWorkspaceRuntime("another-project", context).listFiles()).rejects.toThrow("Authorization rejected");
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it("reads, lists, and writes only through the initiating authorization", async () => {
    const runtime = await getWorkspaceRuntime(projectId, context);
    await runtime.writeFile("nested/file.txt", "authorized");
    await expect(runtime.readFile("nested/file.txt")).resolves.toMatchObject({ content: "authorized" });
    await expect(runtime.listFiles("nested")).resolves.toEqual([{ name: "file.txt", type: "file" }]);
    expect(mocks.revalidate).toHaveBeenCalledWith(context, projectId, "read");
    expect(mocks.revalidate).toHaveBeenCalledWith(context, projectId, "write");
  });

  it.each(["../outside", "/etc/passwd", "C:\\outside", "nested/../../outside", "bad\0name", ".git/config", "nested/.env.production", "nested/key.pem"])("rejects unsafe path %s", async (unsafe) => {
    const runtime = new LocalWorkspaceRuntime(projectId, context);
    await expect(runtime.writeFile(unsafe, "no")).rejects.toThrow();
    await expect(runtime.readFile(unsafe)).rejects.toThrow();
  });

  it("rejects directory and file symlinks and does not expose them in listings", async () => {
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    await fs.symlink(outside, path.join(projectRoot, "linked"), "dir");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(projectRoot, "linked.txt"));
    const runtime = new LocalWorkspaceRuntime(projectId, context);
    await expect(runtime.readFile("linked/secret.txt")).rejects.toThrow("Linked");
    await expect(runtime.writeFile("linked/new.txt", "no")).rejects.toThrow("Linked");
    await expect(runtime.readFile("linked.txt")).rejects.toThrow("Linked");
    await expect(runtime.listFiles()).resolves.toEqual([]);
    await expect(fs.readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe("outside");
  });

  it("rejects a symlinked project root", async () => {
    await fs.rm(projectRoot, { recursive: true });
    await fs.symlink(outside, projectRoot, "dir");
    const runtime = new LocalWorkspaceRuntime(projectId, context);
    await expect(runtime.listFiles()).rejects.toThrow("Symbolic project roots");
  });

  it("rejects FIFO reads and writes without opening a blocking stream", async () => {
    await promisify(execFile)("mkfifo", [path.join(projectRoot, "pipe")]);
    const runtime = new LocalWorkspaceRuntime(projectId, context);
    await expect(runtime.readFile("pipe")).rejects.toThrow("Special files");
    await expect(runtime.writeFile("pipe", "no")).rejects.toThrow("Special files");
  });

  it("does not perform the next write after authorization is revoked", async () => {
    const runtime = new LocalWorkspaceRuntime(projectId, context);
    await runtime.writeFile("first.txt", "allowed");
    mocks.revalidate.mockRejectedValue(new Error("Session revoked"));
    await expect(runtime.writeFile("second.txt", "no")).rejects.toThrow("Session revoked");
    await expect(fs.stat(path.join(projectRoot, "second.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not truncate an existing file when authorization expires before opening", async () => {
    await fs.writeFile(path.join(projectRoot, "existing.txt"), "original");
    mocks.revalidate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Expired"));
    await expect(new LocalWorkspaceRuntime(projectId, context).writeFile("existing.txt", "no")).rejects.toThrow("Expired");
    await expect(fs.readFile(path.join(projectRoot, "existing.txt"), "utf8")).resolves.toBe("original");
  });

  it("blocks host shell and Git commands even with valid owner permission", async () => {
    const runtime = new LocalWorkspaceRuntime(projectId, context);
    await expect(runtime.runCommand({ command: "npm test", commandKey: "npm test", rules: [] })).rejects.toMatchObject({ status: 503 });
    await expect(runtime.gitStatus()).rejects.toMatchObject({ status: 503 });
    await expect(runtime.gitDiff()).rejects.toMatchObject({ status: 503 });
    expect(mocks.sandboxed).not.toHaveBeenCalled();
  });
});

describe("private cloud runtime boundary", () => {
  function setup(sandboxId = "historical-sandbox", state = "started") {
    context = makeContext(true);
    const files = { downloadFile: vi.fn().mockResolvedValue(Buffer.from("cloud")), uploadFile: vi.fn(), createFolder: vi.fn(), listFiles: vi.fn().mockResolvedValue([]) };
    const process = { executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: JSON.stringify({ ok: true, data: { content: "cloud", bytes: 5 } }) }) };
    const sandbox = { id: sandboxId, state, start: vi.fn(), delete: vi.fn(), waitUntilStarted: vi.fn() };
    const provider = { getSandbox: vi.fn().mockResolvedValue(sandbox), findSandboxByName: vi.fn(), ensureSandbox: vi.fn(), createSandbox: vi.fn(),
      getSandboxFileSystem: vi.fn().mockReturnValue(files), getSandboxProcess: vi.fn().mockReturnValue(process) };
    const runtime = new CloudWorkspaceRuntime({ id: `cloud-${projectId}`, projectId,
      provider: provider as unknown as DaytonaProvider, providerWorkspaceId: "historical-sandbox", createdAt: new Date(), authorization: context });
    return { runtime, provider, sandbox, files, process };
  }

  it("uses the persisted provider ID without creating, searching, starting, or remapping", async () => {
    const { runtime, provider, sandbox } = setup();
    await runtime.initialize();
    expect(provider.getSandbox).toHaveBeenCalledExactlyOnceWith("historical-sandbox");
    expect(provider.findSandboxByName).not.toHaveBeenCalled();
    expect(provider.ensureSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(sandbox.start).not.toHaveBeenCalled();
    await expect(runtime.readFile("file.txt")).resolves.toMatchObject({ content: "cloud" });
  });

  it("rejects substituted provider identifiers before contacting Daytona", async () => {
    const { provider } = setup();
    const runtime = new CloudWorkspaceRuntime({ id: "forged", projectId,
      provider: provider as unknown as DaytonaProvider, providerWorkspaceId: "unrelated-sandbox", createdAt: new Date(), authorization: context });
    await expect(runtime.initialize()).rejects.toMatchObject({ status: 403 });
    expect(provider.getSandbox).not.toHaveBeenCalled();
  });

  it.each([["unrelated-sandbox", "started"], ["historical-sandbox", "stopped"], ["historical-sandbox", "error"]])("rejects mismatched or inactive sandbox %s/%s without recovery", async (id, state) => {
    const { runtime, provider, sandbox, files } = setup(id, state);
    await expect(runtime.initialize()).rejects.toMatchObject({ status: 503 });
    expect(provider.ensureSandbox).not.toHaveBeenCalled();
    expect(sandbox.start).not.toHaveBeenCalled();
    expect(sandbox.delete).not.toHaveBeenCalled();
    expect(files.downloadFile).not.toHaveBeenCalled();
  });

  it("fails closed without an SDK fallback when the contained file helper rejects a path", async () => {
    const { runtime, process, files } = setup();
    await runtime.initialize();
    process.executeCommand.mockResolvedValue({ exitCode: 1, result: '{"ok":false}' });
    await expect(runtime.readFile("file.txt")).rejects.toMatchObject({ status: 503 });
    expect(files.downloadFile).not.toHaveBeenCalled();
  });

  it("stops subsequent writes after revocation before any remote operation", async () => {
    const { runtime, files, process } = setup();
    await runtime.initialize();
    mocks.revalidate.mockRejectedValue(new Error("Revoked"));
    await expect(runtime.writeFile("file.txt", "no")).rejects.toThrow("Revoked");
    expect(files.uploadFile).not.toHaveBeenCalled();
    expect(process.executeCommand).not.toHaveBeenCalled();
  });

  it("blocks authorized private writes without transporting raw or encoded content", async () => {
    const { runtime, files, process } = setup();
    await runtime.initialize();
    const content = "private source 🌍\r\n\0$(touch injected)";
    await expect(runtime.writeFile("file.txt", content)).rejects.toMatchObject({ status: 503 });
    expect(mocks.revalidate).toHaveBeenCalledWith(context, projectId, "write");
    expect(files.uploadFile).not.toHaveBeenCalled();
    expect(files.createFolder).not.toHaveBeenCalled();
    expect(process.executeCommand).not.toHaveBeenCalled();
  });

  it("rejects writes with read-only authorization before contacting the filesystem transport", async () => {
    const { runtime, files, process } = setup();
    await runtime.initialize();
    mocks.revalidate.mockImplementation(async (candidate, id, permission) => {
      if (candidate !== context || id !== projectId || permission !== "read") throw new Error("Write not authorized");
    });
    await expect(runtime.writeFile("file.txt", "no")).rejects.toThrow("Write not authorized");
    expect(files.uploadFile).not.toHaveBeenCalled();
    expect(files.createFolder).not.toHaveBeenCalled();
    expect(process.executeCommand).not.toHaveBeenCalled();
  });

  it("preserves exact UTF-8 contents for the supported inactive-stage SDK write path", async () => {
    const { provider, files, process } = setup();
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "false");
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", undefined);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", undefined);
    mocks.revalidate.mockResolvedValue(undefined);
    const runtime = new CloudWorkspaceRuntime({ id: `cloud-${projectId}`, projectId,
      provider: provider as unknown as DaytonaProvider, providerWorkspaceId: "historical-sandbox", createdAt: new Date() });
    await runtime.initialize();
    const content = "exact source 🌍\r\n\t\0e\u0301\n'\"$(touch injected)";
    await expect(runtime.writeFile("nested/file.txt", content)).resolves.toEqual({ bytes: Buffer.byteLength(content, "utf8") });
    expect(files.uploadFile).toHaveBeenCalledExactlyOnceWith(Buffer.from(content, "utf8"), "repo/nested/file.txt");
    expect(process.executeCommand).not.toHaveBeenCalled();
  });

  it("suppresses results when the session is revoked during an external operation", async () => {
    const { runtime, process } = setup();
    await runtime.initialize();
    process.executeCommand.mockImplementation(async () => {
      mocks.revalidate.mockRejectedValue(new Error("Revoked"));
      return { exitCode: 0, result: JSON.stringify({ ok: true, data: { content: "cloud", bytes: 5 } }) };
    });
    await expect(runtime.readFile("file.txt")).rejects.toThrow("Revoked");
  });

  it("blocks general cloud commands and Git operations without starting a remote process", async () => {
    const { runtime, process } = setup();
    await runtime.initialize();
    await expect(runtime.runCommand({ command: "npm test", commandKey: "npm test", rules: [] })).rejects.toMatchObject({ status: 503 });
    await expect(runtime.gitStatus()).rejects.toMatchObject({ status: 503 });
    await expect(runtime.gitDiff("file.txt")).rejects.toMatchObject({ status: 503 });
    await expect(runtime.gitDiff()).rejects.toMatchObject({ status: 403 });
    expect(process.executeCommand).not.toHaveBeenCalled();
  });
});
