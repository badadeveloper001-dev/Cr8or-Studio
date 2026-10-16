import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { PRIVATE_CLOUD_WRITE_SESSION_LIMITS, privateCloudWriteSession } from "@/lib/workspace/private-cloud-write-session";
import { PRIVATE_CLOUD_FILE_LIMITS } from "@/lib/workspace/private-cloud-files";
import { createControlledDaytonaSessionAdapter, type ControlledDaytonaSessionAdapter } from "../helpers/daytona-session-adapter";

const authorization = vi.hoisted(() => {
  class AuthorizationError extends Error {
    constructor(readonly status: number, message = "Authorization unavailable.") { super(message); }
  }
  return { revalidate: vi.fn(), AuthorizationError };
});

vi.mock("@/lib/security/execution-context", () => ({
  ExecutionAuthorizationError: authorization.AuthorizationError,
  revalidateExecutionAuthorization: authorization.revalidate,
}));

let root: string;
let adapter: ControlledDaytonaSessionAdapter;
let context: ExecutionAuthorizationContext;
let revoked: boolean;
const projectId = "registered-project";
const sandboxId = "registered-sandbox";
const target = "source.ts";
const original = "original source contents\n";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-write-session-"));
  await fs.mkdir(path.join(root, "repo"));
  await fs.writeFile(path.join(root, "repo", target), original);
  adapter = createControlledDaytonaSessionAdapter(root);
  context = {
    ownerId: "owner", projectId,
    workspace: { id: "registered-workspace", runtimeType: "cloud", provider: "daytona", providerWorkspaceId: sandboxId,
      repositoryUrl: null, branch: null },
    permissions: ["write"], signal: new AbortController().signal,
  } as unknown as ExecutionAuthorizationContext;
  revoked = false;
  authorization.revalidate.mockReset().mockImplementation(async (candidate, requestedProject, operation) => {
    if (candidate !== context || revoked || context.signal.aborted) throw new authorization.AuthorizationError(401);
    if (requestedProject !== projectId || operation !== "write" || !context.permissions.includes("write")) {
      throw new authorization.AuthorizationError(403);
    }
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await adapter.dispose();
  await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const write = (content: string, filename = target, candidate = context) =>
  privateCloudWriteSession(adapter, projectId, sandboxId, filename, content, candidate);
const stored = () => fs.readFile(path.join(root, "repo", target), "utf8");
const commits = () => adapter.calls.inputs.filter(({ data }) => / COMMIT\n$/.test(data));

describe("controlled Daytona session transport with the real Python helper", () => {
  it.each([
    ["Unicode and control bytes", "source 🌍\r\n\t\0e\u0301\u2028𝄞\n"],
    ["empty file", ""],
    ["shell syntax as inert file contents", "$(touch injected); `touch injected` ' \"\n"],
    ["replacement of an existing source file", "export const changed = true;\n"],
  ])("preserves exact UTF-8 for %s", async (_name, content) => {
    await expect(write(content)).resolves.toEqual({ bytes: Buffer.byteLength(content, "utf8") });
    expect(await stored()).toBe(content);
    expect(commits()).toHaveLength(1);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
    expect(adapter.activeCommands.size).toBe(0);
    expect(await fs.readdir(path.join(root, "repo"))).toEqual([target]);
    await expect(fs.stat(path.join(root, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a new file without changing other source files", async () => {
    await expect(write("new file\n", "new.ts")).resolves.toEqual({ bytes: 9 });
    expect(await stored()).toBe(original);
    expect(await fs.readFile(path.join(root, "repo", "new.ts"), "utf8")).toBe("new file\n");
  });

  it("transfers the maximum UTF-8 size using bounded frames", async () => {
    const content = "🌍".repeat(PRIVATE_CLOUD_FILE_LIMITS.writeBytes / 4);
    await expect(write(content)).resolves.toEqual({ bytes: PRIVATE_CLOUD_FILE_LIMITS.writeBytes });
    expect(await stored()).toBe(content);
    const data = adapter.calls.inputs.filter(({ data }) => / DATA /.test(data));
    expect(data.length).toBeGreaterThan(1);
    for (const frame of data) {
      expect(Buffer.byteLength(frame.data, "utf8")).toBeLessThan(17 * 1024);
      const encoded = frame.data.trimEnd().split(" ").at(-1)!;
      expect(Buffer.from(encoded, "base64").length).toBeLessThanOrEqual(12 * 1024);
    }
  });

  it("keeps private content out of commands, session identifiers, and execution options", async () => {
    const content = "PRIVATE_CONTENT_MARKER_7a976e87_🌍\n";
    const token = "SYNTHETIC_AUTHORIZATION_SECRET_MUST_NOT_TRANSFER_4490";
    Object.assign(context, { internalSessionToken: token });
    const logs = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => {}));
    await write(content);
    const commandMetadata = JSON.stringify({ created: adapter.calls.created, commands: adapter.calls.commands });
    expect(commandMetadata).not.toContain(content);
    expect(commandMetadata).not.toContain(Buffer.from(content, "utf8").toString("base64"));
    expect(JSON.stringify(adapter.calls)).not.toContain(token);
    for (const { request } of adapter.calls.commands) {
      expect(request).toMatchObject({ runAsync: true, suppressInputEcho: true });
      expect(Object.keys(request).sort()).toEqual(["command", "runAsync", "suppressInputEcho"]);
    }
    expect(adapter.calls.inputs.some(({ data }) => data.includes(Buffer.from(content).toString("base64")))).toBe(true);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("revalidates authorization after staging and immediately before the commit message", async () => {
    let staged = false;
    let revalidatedAfterStaging = false;
    const validate = authorization.revalidate.getMockImplementation()!;
    authorization.revalidate.mockImplementation(async (...args) => {
      await validate(...args);
      if (staged) revalidatedAfterStaging = true;
    });
    adapter = createControlledDaytonaSessionAdapter(root, {
      onLogs(logs) { if (/ STAGED \d+\n/.test(logs.stdout)) staged = true; },
      beforeInput(input) {
        if (/ COMMIT\n$/.test(input)) expect(revalidatedAfterStaging).toBe(true);
      },
    });
    await write("authorized replacement");
    expect(staged).toBe(true);
    expect(revalidatedAfterStaging).toBe(true);
    expect(authorization.revalidate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it.each(["revocation", "credential rotation", "expiration"])("preserves the destination when %s is detected before commit", async () => {
    adapter = createControlledDaytonaSessionAdapter(root, {
      onLogs(logs) { if (/ STAGED \d+\n/.test(logs.stdout)) revoked = true; },
    });
    await expect(write("must not commit")).rejects.toMatchObject({ status: 401 });
    expect(await stored()).toBe(original);
    expect(commits()).toHaveLength(0);
    expect(await fs.readdir(path.join(root, "repo"))).toEqual([target]);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
  });

  it("does not authorize subsequent operations after an invalidation", async () => {
    adapter = createControlledDaytonaSessionAdapter(root, {
      onLogs(logs) { if (/ STAGED \d+\n/.test(logs.stdout)) revoked = true; },
    });
    await expect(write("first")).rejects.toMatchObject({ status: 401 });
    const started = adapter.calls.created.length;
    await expect(write("second")).rejects.toMatchObject({ status: 401 });
    expect(adapter.calls.created).toHaveLength(started);
    expect(await stored()).toBe(original);
  });

  it.each(["../outside.ts", "/etc/passwd", ".env", ".git/config", "nested/.env.production"])("rejects unsafe path %s before remote initialization", async (filename) => {
    await expect(write("private source", filename)).rejects.toThrow();
    expect(adapter.calls.created).toHaveLength(0);
    expect(await stored()).toBe(original);
  });

  it.each(["a".repeat(PRIVATE_CLOUD_FILE_LIMITS.writeBytes + 1), "🌍".repeat(PRIVATE_CLOUD_FILE_LIMITS.writeBytes / 4 + 1)])(
    "rejects oversized content before remote initialization", async (content) => {
      await expect(write(content)).rejects.toMatchObject({ status: 409 });
      expect(adapter.calls.created).toHaveLength(0);
      expect(await stored()).toBe(original);
    },
  );

  it.each(["\ud800", "\udc00", "valid\ud800invalid"])("rejects malformed UTF-16 rather than silently replacing bytes", async (content) => {
    await expect(write(content)).rejects.toThrow();
    expect(adapter.calls.created).toHaveLength(0);
    expect(await stored()).toBe(original);
  });

  it("rejects an oversized relative path before dispatch", async () => {
    await expect(write("ok", "a".repeat(PRIVATE_CLOUD_FILE_LIMITS.pathBytes + 1))).rejects.toMatchObject({ status: 409 });
    expect(adapter.calls.created).toHaveLength(0);
  });

  it.each(["missing", "fabricated", "read-only", "wrong-project", "wrong-sandbox"])("rejects %s authority before opening a session", async (failure) => {
    let candidate = context;
    let requestedProject = projectId;
    let requestedSandbox = sandboxId;
    if (failure === "missing") candidate = undefined as unknown as ExecutionAuthorizationContext;
    if (failure === "fabricated") candidate = { ...context } as ExecutionAuthorizationContext;
    if (failure === "read-only") Object.assign(context, { permissions: ["read"] });
    if (failure === "wrong-project") requestedProject = "unregistered-project";
    if (failure === "wrong-sandbox") requestedSandbox = "other-sandbox";
    await expect(privateCloudWriteSession(adapter, requestedProject, requestedSandbox, target, "no", candidate)).rejects.toThrow();
    expect(adapter.calls.created).toHaveLength(0);
    expect(await stored()).toBe(original);
  });

  it("preserves the destination and removes staging files after an interrupted transfer", async () => {
    adapter = createControlledDaytonaSessionAdapter(root, {
      beforeInput(input) { if (/ DATA /.test(input)) throw new Error("sensitive provider detail"); },
    });
    await expect(write("new private data")).rejects.toMatchObject({ status: 503 });
    expect(await stored()).toBe(original);
    expect(commits()).toHaveLength(0);
    expect(await fs.readdir(path.join(root, "repo"))).toEqual([target]);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
  });

  it("detects a lost content frame without replacing the destination", async () => {
    const send = adapter.sendSessionCommandInput.bind(adapter);
    vi.spyOn(adapter, "sendSessionCommandInput").mockImplementation(async (sessionId, commandId, input) => {
      if (/ DATA /.test(input)) return;
      await send(sessionId, commandId, input);
    });
    await expect(write("incomplete content")).rejects.toMatchObject({ status: 503 });
    expect(await stored()).toBe(original);
    expect(commits()).toHaveLength(0);
    expect(await fs.readdir(path.join(root, "repo"))).toEqual([target]);
  });

  it("detects malformed content frames without replacing the destination", async () => {
    const send = adapter.sendSessionCommandInput.bind(adapter);
    vi.spyOn(adapter, "sendSessionCommandInput").mockImplementation(async (sessionId, commandId, input) => {
      await send(sessionId, commandId, input.replace(/( DATA \d+ )[^\n]+/, "$1INVALID!"));
    });
    await expect(write("bad frame")).rejects.toMatchObject({ status: 503 });
    expect(await stored()).toBe(original);
    expect(commits()).toHaveLength(0);
  });

  it("does not retry a commit after its provider acknowledgement is lost", async () => {
    const content = "committed before acknowledgement failed\n";
    const send = adapter.sendSessionCommandInput.bind(adapter);
    vi.spyOn(adapter, "sendSessionCommandInput").mockImplementation(async (sessionId, commandId, input) => {
      await send(sessionId, commandId, input);
      if (/ COMMIT\n$/.test(input)) {
        await vi.waitFor(async () => expect(await stored()).toBe(content), { timeout: 2000, interval: 10 });
        throw new Error("provider response disconnected");
      }
    });
    await expect(write(content)).rejects.toMatchObject({ status: 503 });
    expect(await stored()).toBe(content);
    expect(commits()).toHaveLength(1);
    expect(adapter.calls.commands).toHaveLength(1);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
  });
});

describe("provider failures fail closed without disclosing content", () => {
  const privateDetail = "PRIVATE_PROVIDER_RESPONSE_MARKER_9b9d7a3e";

  it.each(["createSession", "executeSessionCommand", "sendSessionCommandInput", "getSessionCommandLogs", "getSessionCommand"] as const)(
    "sanitizes %s failures", async (operation) => {
      vi.spyOn(adapter, operation).mockRejectedValue(new Error(privateDetail));
      const error = await write("private source").catch((failure: unknown) => failure);
      expect(error).toMatchObject({ status: 503 });
      expect(String(error)).not.toContain(privateDetail);
      expect(String(error)).not.toContain("private source");
      expect(await stored()).toBe(original);
      expect(commits()).toHaveLength(0);
    },
  );

  it.each(["stderr", "unexpected output", "oversized output", "wrong nonce", "premature commit"])("rejects %s", async (failure) => {
    adapter = createControlledDaytonaSessionAdapter(root, {
      transformLogs(logs) {
        if (failure === "stderr") return { ...logs, stderr: privateDetail };
        if (failure === "unexpected output") return { ...logs, stdout: privateDetail + "\n" };
        if (failure === "oversized output") return { ...logs, output: "x".repeat(PRIVATE_CLOUD_FILE_LIMITS.outputBytes + 1) };
        if (failure === "wrong nonce") return { ...logs, stdout: logs.stdout.replace(/[a-f0-9]{32}/g, "0".repeat(32)) };
        return { ...logs, stdout: logs.stdout.replace(" READY\n", " COMMITTED 0\n") };
      },
    });
    const error = await write("private source").catch((failure: unknown) => failure);
    expect(error).toHaveProperty("status");
    expect(String(error)).not.toContain(privateDetail);
    expect(String(error)).not.toContain("private source");
    expect(await stored()).toBe(original);
    expect(commits()).toHaveLength(0);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
  });

  it("reports unconfirmed session cleanup without concealing a completed replacement", async () => {
    const deletion = vi.spyOn(adapter, "deleteSession").mockRejectedValue(new Error(privateDetail));
    try {
      const error = await write("completed replacement").catch((failure: unknown) => failure);
      expect(error).toMatchObject({ status: 503 });
      expect(String(error)).not.toContain(privateDetail);
      expect(await stored()).toBe("completed replacement");
      expect(commits()).toHaveLength(1);
      expect(deletion).toHaveBeenCalledOnce();
    } finally { deletion.mockRestore(); }
  });
});

describe("bounded session waits and cancellation", () => {
  function disconnectedProvider() {
    return {
      createSession: vi.fn().mockResolvedValue(undefined),
      executeSessionCommand: vi.fn().mockResolvedValue({ cmdId: "test-command" }),
      sendSessionCommandInput: vi.fn().mockResolvedValue(undefined),
      getSessionCommandLogs: vi.fn().mockImplementation(() => new Promise(() => {})),
      getSessionCommand: vi.fn().mockResolvedValue({ id: "test-command", command: "fixed helper" }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("bounds a disconnected provider and attempts execution-session cleanup", async () => {
    vi.useFakeTimers();
    const provider = disconnectedProvider();
    const result = privateCloudWriteSession(provider, projectId, sandboxId, target, "not committed", context);
    const rejected = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(PRIVATE_CLOUD_WRITE_SESSION_LIMITS.operationMs + PRIVATE_CLOUD_WRITE_SESSION_LIMITS.cleanupMs + 100);
    await rejected;
    expect(provider.createSession).toHaveBeenCalledOnce();
    expect(provider.deleteSession).toHaveBeenCalled();
    expect(await stored()).toBe(original);
  });

  it("attempts compensating deletion when session creation resolves after the deadline", async () => {
    vi.useFakeTimers();
    const provider = disconnectedProvider();
    let completeCreation: (() => void) | undefined;
    provider.createSession.mockImplementation(() => new Promise<void>((resolve) => { completeCreation = resolve; }));
    const result = privateCloudWriteSession(provider, projectId, sandboxId, target, "not committed", context);
    const rejected = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(PRIVATE_CLOUD_WRITE_SESSION_LIMITS.operationMs + PRIVATE_CLOUD_WRITE_SESSION_LIMITS.cleanupMs + 100);
    await rejected;
    const deletionsBeforeCreation = provider.deleteSession.mock.calls.length;
    completeCreation!();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.deleteSession.mock.calls.length).toBeGreaterThan(deletionsBeforeCreation);
    expect(provider.executeSessionCommand).not.toHaveBeenCalled();
    expect(await stored()).toBe(original);
  });

  it("stops a staged transfer when the initiating request is cancelled", async () => {
    const controller = new AbortController();
    Object.assign(context, { signal: controller.signal });
    adapter = createControlledDaytonaSessionAdapter(root, {
      onLogs(logs) { if (/ STAGED \d+\n/.test(logs.stdout)) controller.abort(); },
    });
    await expect(write("cancelled source")).rejects.toMatchObject({ status: 401 });
    expect(await stored()).toBe(original);
    expect(commits()).toHaveLength(0);
    expect(await fs.readdir(path.join(root, "repo"))).toEqual([target]);
    expect(adapter.calls.deleted).toEqual(adapter.calls.created);
  });
});
