import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { buildGitOperationScope, parseGitOperation, type GitOperationRequest, type GitOperationScope } from "@/lib/security/git-operation-catalogue";
import { privateGitSession, PRIVATE_GIT_SESSION_LIMITS } from "@/lib/workspace/private-git-session";
import type { PrivateCloudSessionProcess } from "@/lib/workspace/private-cloud-write-session";

const READY = "CR8OR-GIT/1 READY\n", RESULT = "CR8OR-GIT/1 RESULT ";
const state = { head: "a".repeat(40), branch: "main", index: "b".repeat(64) };
const registration = { projectId: "registered-fixture", workspace: {
  id: "registry-fixture", runtimeType: "cloud" as const, provider: "daytona", providerWorkspaceId: "daytona-fixture",
  repositoryUrl: "https://github.com/badadeveloper001-dev/cr8or-studio.git", branch: "main",
} };
function scope(request: GitOperationRequest) { return buildGitOperationScope(registration, request); }
function request(operation = "stage") {
  return parseGitOperation(operation === "stage" ? { operation, branch: "main", paths: ["src/private-file.ts"], expectedHead: state.head, expectedIndex: state.index } : { operation });
}

/** Controlled SDK messages only. Real helper/filesystem tests live separately;
 * this fixture makes no claim about live Daytona behavior or isolation. */
function adapter(data: unknown = { ...state, operation: "stage" }) {
  let output = "", terminal = false, code = 0;
  const frames: string[] = [];
  const provider = {
    createSession: vi.fn(async () => undefined),
    executeSessionCommand: vi.fn(async () => ({ cmdId: "fixture-command", stdout: "" })),
    sendSessionCommandInput: vi.fn(async (_session: string, _command: string, frame: string) => {
      frames.push(frame);
      if (frame.startsWith("{")) output = READY;
      else if (frame === "START\n") { output = READY + RESULT + JSON.stringify({ ok: true, data }) + "\n"; terminal = true; }
      else if (frame === "CANCEL\n") { output = READY + RESULT + JSON.stringify({ ok: false, error: "CANCELLED" }) + "\n"; terminal = true; code = 1; }
    }),
    getSessionCommandLogs: vi.fn(async () => ({ stdout: output })),
    getSessionCommand: vi.fn(async () => ({ exitCode: terminal ? code : undefined })),
    deleteSession: vi.fn(async () => undefined),
  };
  const transport = provider as unknown as PrivateCloudSessionProcess;
  return { provider, transport, frames, setOutput: (value: string, exitCode?: number) => {
    output = value; terminal = exitCode !== undefined; code = exitCode ?? 0;
  } };
}
async function run(fixture = adapter(), input = request(), check: () => Promise<void> = vi.fn(async () => undefined), signal = new AbortController().signal) {
  return privateGitSession(fixture.transport, input, scope(input), check, signal);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("private Git fixed-purpose session transport", () => {
  it("frames metadata through stdin, revalidates before START and never sends credentials or request fields in argv", async () => {
    const fixture = adapter();
    const check = vi.fn(async () => undefined);
    const result = await run(fixture, request(), check);
    expect(result).toEqual({ status: "SUCCEEDED", data: { ...state, operation: "stage" }, cancellationConfirmed: true, cleanupConfirmed: true });
    const submitted = fixture.provider.executeSessionCommand.mock.calls[0] as unknown as [string, Record<string, unknown>, number];
    expect(submitted[0]).toMatch(/^cr8or-git-[a-f0-9-]{36}$/);
    expect(Object.keys(submitted[1]).sort()).toEqual(["command", "runAsync", "suppressInputEcho"]);
    expect(submitted[1]).toMatchObject({ runAsync: true, suppressInputEcho: true });
    expect(submitted[1].command).toMatch(/^exec python3 -I -S -u -c '/);
    expect(submitted[1].command).not.toContain("src/private-file.ts");
    expect(submitted[1].command).not.toContain("daytona-fixture");
    expect(submitted[1].command).not.toContain(state.head);
    expect(submitted[2]).toBe(5);
    expect(JSON.parse(fixture.frames[0])).toEqual({ operation: "stage", branch: "main", paths: ["src/private-file.ts"],
      expectedHead: state.head, expectedIndex: state.index, expectedRepository: "https://github.com/badadeveloper001-dev/cr8or-studio.git" });
    expect(fixture.frames[1]).toBe("START\n");
    expect(check.mock.invocationCallOrder[3]).toBeLessThan(fixture.provider.sendSessionCommandInput.mock.invocationCallOrder[1]);
    expect(check).toHaveBeenCalledTimes(6);
    expect(fixture.provider.deleteSession).toHaveBeenCalledOnce();
  });

  it.each([
    ["branch", state], ["status", { ...state, changes: [{ status: " M", path: "src/test.ts" }] }],
    ["changes", { ...state, changes: [] }], ["log", { commits: [{ sha: state.head, timestamp: 123, title: "Commit" }] }],
    ["remote", { name: "origin", url: "https://github.com/badadeveloper001-dev/cr8or-studio.git" }],
  ])("preserves bounded %s read results and sends registered branch metadata", async (operation, data) => {
    const fixture = adapter(data);
    expect(await run(fixture, request(operation as string))).toMatchObject({ status: "SUCCEEDED", data });
    expect(JSON.parse(fixture.frames[0])).toEqual({ operation, branch: "main", expectedRepository: "https://github.com/badadeveloper001-dev/cr8or-studio.git" });
  });

  it("preserves Unicode diff output without truncation", async () => {
    const data = { unstaged: "+你好 🌍\n", staged: "-old\n+new\n" };
    const fixture = adapter(data);
    const input = parseGitOperation({ operation: "diff", paths: ["src/你好.ts"] });
    expect(await run(fixture, input)).toMatchObject({ status: "SUCCEEDED", data });
  });

  it("sends only the exact neutral approved commit category", async () => {
    const fixture = adapter({ ...state, operation: "commit", title: "CR8OR-002: Code improvements" });
    const input = parseGitOperation({ operation: "commit", branch: "main", expectedHead: state.head, expectedIndex: state.index, category: "Code improvements" });
    expect(await run(fixture, input)).toMatchObject({ status: "SUCCEEDED" });
    expect(JSON.parse(fixture.frames[0])).toMatchObject({ commitPrefix: "CR8OR", category: "Code improvements" });
  });

  it.each(["PROJECT-002: Code improvements", "OTHER-002: Code improvements", "CR8OR-002: General maintenance",
    "CR8OR-000: Code improvements", "CR8OR-0002: Code improvements", "CR8OR-1000000000: Code improvements"])
  ("withholds malformed or substituted commit receipt %s", async (title) => {
    const fixture = adapter({ ...state, operation: "commit", title });
    const input = parseGitOperation({ operation: "commit", branch: "main", expectedHead: state.head, expectedIndex: state.index, category: "Code improvements" });
    const result = await run(fixture, input);
    expect(result).toMatchObject({ status: "UNKNOWN" });
    expect(result).not.toHaveProperty("data");
  });

  it.each(["projectId", "providerWorkspaceId", "repositoryKey", "branch", "payloadDigest"])("rejects a mismatched %s scope before provider access", async (field) => {
    const fixture = adapter(), input = request();
    const value = field === "payloadDigest" ? "c".repeat(64) : field === "repositoryKey" ? "other/repository" : "other";
    // Project/provider cannot be independently inferred from request metadata;
    // the trusted callback validates those actual capability identities.
    const forged = { ...scope(input), [field]: value } as GitOperationScope;
    const validate = vi.fn(async () => { if (field === "projectId" || field === "providerWorkspaceId" || field === "repositoryKey") throw new ExecutionAuthorizationError(403); });
    await expect(privateGitSession(fixture.transport, input, forged, validate, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect(fixture.provider.createSession).not.toHaveBeenCalled();
  });

  it("rejects GitHub-only operations before starting a remote helper", async () => {
    const fixture = adapter();
    const input = parseGitOperation({ operation: "push", branch: "main", expectedRemoteHead: state.head, targetCommit: "c".repeat(40) });
    await expect(run(fixture, input)).rejects.toMatchObject({ status: 403 });
    expect(fixture.provider.createSession).not.toHaveBeenCalled();
  });

  it("does not send START after authorization is revoked during preflight", async () => {
    const fixture = adapter();
    const validate = vi.fn(async () => { if (validate.mock.calls.length >= 4) throw new ExecutionAuthorizationError(401); });
    await expect(run(fixture, request(), validate)).rejects.toMatchObject({ status: 401 });
    expect(fixture.frames).not.toContain("START\n");
    expect(fixture.frames).toContain("CANCEL\n");
    expect(fixture.provider.deleteSession).toHaveBeenCalledOnce();
  });

  it("withholds output when credential rotation invalidates authorization after execution", async () => {
    const fixture = adapter();
    const validate = vi.fn(async () => { if (validate.mock.calls.length >= 5) throw new ExecutionAuthorizationError(401); });
    await expect(run(fixture, request(), validate)).rejects.toMatchObject({ status: 401 });
    expect(fixture.frames).toContain("START\n");
    expect(fixture.provider.deleteSession).toHaveBeenCalledOnce();
  });

  it("does not release output when the final authorization database check fails", async () => {
    const fixture = adapter();
    const validate = vi.fn(async () => { if (validate.mock.calls.length >= 6) throw new ExecutionAuthorizationError(503); });
    expect(await run(fixture, request(), validate)).toMatchObject({ status: "UNKNOWN" });
  });

  it.each([
    { ...state, branch: "unapproved", operation: "stage" },
    { ...state, operation: "stage", providerToken: "sensitive-provider-token" },
    { head: state.head, branch: "main", index: "invalid", operation: "stage" },
  ])("rejects malformed or substituted helper output without releasing it", async (data) => {
    const result = await run(adapter(data));
    expect(result).toMatchObject({ status: "UNKNOWN" });
    expect(result).not.toHaveProperty("data");
    expect(JSON.stringify(result)).not.toContain("sensitive-provider-token");
  });

  it("never releases credential-bearing remote URLs", async () => {
    const result = await run(adapter({ name: "origin", url: "https://secret@github.com/fixture/repo.git" }), request("remote"));
    expect(result.status).toBe("UNKNOWN");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not treat deleted sessions as confirmed Git completion", async () => {
    const fixture = adapter();
    fixture.provider.executeSessionCommand.mockRejectedValue(new Error("provider token and private host"));
    const result = await run(fixture);
    expect(result).toEqual({ status: "UNKNOWN", cancellationConfirmed: false, cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toContain("provider token");
  });

  it("reports cleanup failure as UNKNOWN even with a valid completion envelope", async () => {
    const fixture = adapter();
    fixture.provider.deleteSession.mockRejectedValue(new Error("sensitive provider detail"));
    expect(await run(fixture)).toEqual({ status: "UNKNOWN", cancellationConfirmed: true, cleanupConfirmed: false });
  });

  it.each(["CONFLICT", "BUSY", "REJECTED", "LIMIT"])("returns bounded failed status for confirmed %s results", async (error) => {
    const fixture = adapter();
    const original = fixture.provider.sendSessionCommandInput.getMockImplementation()!;
    fixture.provider.sendSessionCommandInput.mockImplementation(async (...args) => {
      await original(...args);
      if (args[2] === "START\n") fixture.setOutput(READY + RESULT + JSON.stringify({ ok: false, error }) + "\n", 1);
    });
    expect(await run(fixture)).toEqual({ status: "FAILED", cancellationConfirmed: true, cleanupConfirmed: true });
  });

  it("retains ambiguous mutation outcomes as UNKNOWN", async () => {
    const fixture = adapter();
    const original = fixture.provider.sendSessionCommandInput.getMockImplementation()!;
    fixture.provider.sendSessionCommandInput.mockImplementation(async (...args) => {
      if (args[2] === "CANCEL\n") return;
      await original(...args);
      if (args[2] === "START\n") fixture.setOutput(READY + RESULT + JSON.stringify({ ok: false, error: "UNCERTAIN" }) + "\n", 1);
    });
    expect(await run(fixture)).toEqual({ status: "UNKNOWN", cancellationConfirmed: false, cleanupConfirmed: true });
  });

  it("rejects oversized or echoed output without exposing transcript contents", async () => {
    const fixture = adapter();
    fixture.provider.getSessionCommandLogs.mockResolvedValue({ stdout: "private-source".repeat(PRIVATE_GIT_SESSION_LIMITS.outputBytes) });
    const result = await run(fixture);
    expect(result.status).toBe("UNKNOWN");
    expect(JSON.stringify(result)).not.toContain("private-source");
  });

  it("honors request cancellation before creating a provider session", async () => {
    const fixture = adapter(), controller = new AbortController();
    controller.abort();
    await expect(run(fixture, request(), vi.fn(async () => undefined), controller.signal)).rejects.toMatchObject({ status: 401 });
    expect(fixture.provider.createSession).not.toHaveBeenCalled();
  });

  it("revalidates a running Git operation and cancels on session expiration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fixture = adapter();
    const original = fixture.provider.sendSessionCommandInput.getMockImplementation()!;
    fixture.provider.sendSessionCommandInput.mockImplementation(async (...args) => {
      await original(...args);
      if (args[2] === "START\n") fixture.setOutput(READY);
    });
    const validate = vi.fn(async () => { if (validate.mock.calls.length >= 5) throw new ExecutionAuthorizationError(401); });
    const pending = run(fixture, request(), validate).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toMatchObject({ status: 401 });
    expect(fixture.frames).toContain("CANCEL\n");
    expect(fixture.provider.deleteSession).toHaveBeenCalledOnce();
  });

  it("honors a disconnect after START and attempts remote cancellation", async () => {
    const fixture = adapter(), controller = new AbortController();
    const original = fixture.provider.sendSessionCommandInput.getMockImplementation()!;
    fixture.provider.sendSessionCommandInput.mockImplementation(async (...args) => {
      await original(...args);
      if (args[2] === "START\n") { fixture.setOutput(READY); controller.abort(); }
    });
    await expect(run(fixture, request(), vi.fn(async () => undefined), controller.signal)).rejects.toMatchObject({ status: 401 });
    expect(fixture.frames).toContain("CANCEL\n");
    expect(fixture.provider.deleteSession).toHaveBeenCalledOnce();
  });

  it("bounds overall operation duration without presenting incomplete output as success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fixture = adapter();
    const original = fixture.provider.sendSessionCommandInput.getMockImplementation()!;
    fixture.provider.sendSessionCommandInput.mockImplementation(async (...args) => {
      await original(...args);
      if (args[2] === "START\n") fixture.setOutput(READY);
    });
    const pending = run(fixture);
    await vi.advanceTimersByTimeAsync(PRIVATE_GIT_SESSION_LIMITS.durationMs + 1000);
    expect(await pending).toEqual({ status: "UNKNOWN", cancellationConfirmed: true, cleanupConfirmed: true });
    expect(fixture.frames).toContain("CANCEL\n");
  });

  it("bounds stalled provider calls and cleans up the attempted session", async () => {
    vi.useFakeTimers();
    const fixture = adapter();
    fixture.provider.createSession.mockImplementation(() => new Promise(() => undefined));
    const pending = run(fixture);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toEqual({ status: "UNKNOWN", cancellationConfirmed: true, cleanupConfirmed: true });
    expect(fixture.provider.executeSessionCommand).not.toHaveBeenCalled();
    expect(fixture.provider.deleteSession).toHaveBeenCalledOnce();
  });
});
