import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(), reserve: vi.fn(), mark: vi.fn(), finish: vi.fn(), audit: vi.fn(), github: vi.fn(), session: vi.fn(),
}));
vi.mock("@/lib/security/git-authorization", () => ({ validateGitAuthorization: mocks.validate }));
vi.mock("@/lib/security/git-operation-store", () => ({ reserveGitOperation: mocks.reserve, markGitDispatched: mocks.mark, finishGitOperation: mocks.finish }));
vi.mock("@/lib/security/audit", () => ({ appendAuditEvent: mocks.audit }));
vi.mock("@/lib/workspace/private-github-api", () => ({ executePrivateGithubOperation: mocks.github }));
vi.mock("@/lib/workspace/private-git-session", () => ({ privateGitSession: mocks.session }));

import { ExecutionAuthorizationError, type ExecutionAuthorizationContext, type ExecutionWorkspace } from "@/lib/security/execution-context";
import type { GitAuthorization } from "@/lib/security/git-authorization";
import { buildGitOperationScope, parseGitOperation, type GitOperationRequest } from "@/lib/security/git-operation-catalogue";
import {
  createDaytonaGitAdapter, createGithubGitAdapter, executeAuthorizedGitOperation,
  type GitExecutionAdapter, type GitTransportResult,
} from "@/lib/workspace/private-git-operations";
import type { DaytonaProvider } from "@/lib/workspace/providers/daytona";

const head = "a".repeat(40), otherHead = "b".repeat(40), index = "c".repeat(64);
const workspace: ExecutionWorkspace = { id: "workspace-a", runtimeType: "cloud", provider: "daytona",
  providerWorkspaceId: "sandbox-a", repositoryUrl: "https://github.com/badadeveloper001-dev/cr8or-studio.git", branch: "main" };
const mutation = parseGitOperation({ operation: "commit", branch: "main", expectedHead: head, expectedIndex: index, category: "Code improvements" });
const read = parseGitOperation({ operation: "status" });
const push = parseGitOperation({ operation: "push", branch: "main", expectedRemoteHead: head, targetCommit: otherHead });
const update = parseGitOperation({ operation: "upsert-file", branch: "main", expectedRemoteHead: head,
  expectedBlob: null, filePath: "src/app.ts", content: "private synthetic fixture content", category: "Code improvements" });
const operationId = "fa4fcf31-92ea-4a54-8289-5867038f1fe2";
const grant = Object.freeze({}) as GitAuthorization;
let controller: AbortController;
let context: ExecutionAuthorizationContext;
let adapter: GitExecutionAdapter;
const complete: GitTransportResult = { status: "SUCCEEDED", data: { changed: true }, cancellationConfirmed: true, cleanupConfirmed: true };
const noResult = () => new Promise<GitTransportResult>(() => undefined);

beforeEach(() => {
  vi.resetAllMocks();
  controller = new AbortController();
  context = { projectId: "project-a", workspace, signal: controller.signal, executionId: "execution-a" } as unknown as ExecutionAuthorizationContext;
  mocks.validate.mockImplementation(async (_grant, _context, request) => ({
    operationId, executionId: "execution-a", actorId: "frontend", scope: buildGitOperationScope(context, request),
  }));
  mocks.reserve.mockResolvedValue(undefined);
  mocks.mark.mockResolvedValue(undefined);
  mocks.finish.mockResolvedValue(undefined);
  adapter = { kind: "daytona", execute: vi.fn().mockResolvedValue(complete) };
});
afterEach(() => vi.useRealTimers());

describe("authorized Git operation coordination", () => {
  it("reserves the exact canonical mutation before dispatch and releases only confirmed completion", async () => {
    const result = await executeAuthorizedGitOperation(grant, context, mutation, adapter);
    expect(result).toEqual({ ...complete, operationId });
    expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: operationId,
      projectId: "project-a", workspaceId: "sandbox-a", repositoryKey: "badadeveloper001-dev/cr8or-studio", operationKey: "commit" }));
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith(operationId);
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(operationId, { status: "SUCCEEDED", exitCode: 0,
      cancellationConfirmed: true, cleanupConfirmed: true });
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.mark.mock.invocationCallOrder[0]);
    expect(mocks.mark.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(adapter.execute).mock.invocationCallOrder[0]);
    expect(mocks.validate.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(mocks.audit.mock.calls.map(([event]) => event.metadata.status)).toEqual(["RUNNING", "SUCCEEDED"]);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("changed");
  });

  it("validates read operations without granting mutation reservations", async () => {
    expect((await executeAuthorizedGitOperation(grant, context, read, adapter)).status).toBe("SUCCEEDED");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.validate.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it.each([401, 403, 409, 503] as const)("rejects initial authorization failure %s before reservation or dispatch", async status => {
    mocks.validate.mockRejectedValue(new ExecutionAuthorizationError(status));
    await expect(executeAuthorizedGitOperation(grant, context, mutation, adapter)).rejects.toMatchObject({ status });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("rejects cross-provider operation substitution", async () => {
    await expect(executeAuthorizedGitOperation(grant, context, push, adapter)).rejects.toMatchObject({ status: 403 });
    await expect(executeAuthorizedGitOperation(grant, context, mutation, { ...adapter, kind: "github" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("does not dispatch duplicate or conflicting reservations", async () => {
    mocks.reserve.mockRejectedValue(new ExecutionAuthorizationError(409));
    await expect(executeAuthorizedGitOperation(grant, context, mutation, adapter)).rejects.toMatchObject({ status: 409 });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("shared reservation rejection prevents a second concurrent dispatch", async () => {
    let acquired = false;
    mocks.reserve.mockImplementation(async () => {
      if (acquired) throw new ExecutionAuthorizationError(409);
      acquired = true;
    });
    const results = await Promise.allSettled([
      executeAuthorizedGitOperation(grant, context, mutation, adapter),
      executeAuthorizedGitOperation(grant, context, mutation, adapter),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(adapter.execute).toHaveBeenCalledOnce();
  });

  it("fails closed and sanitizes reservation infrastructure errors", async () => {
    mocks.reserve.mockRejectedValue(new Error("postgres://private-user:secret@database"));
    const error = await executeAuthorizedGitOperation(grant, context, mutation, adapter).catch(error => error);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain("secret");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("cancels a reservation when authorization fails immediately before dispatch", async () => {
    mocks.validate.mockResolvedValueOnce({ operationId, executionId: "execution-a", actorId: "frontend", scope: buildGitOperationScope(context, mutation) })
      .mockRejectedValue(new ExecutionAuthorizationError(401));
    await expect(executeAuthorizedGitOperation(grant, context, mutation, adapter)).rejects.toMatchObject({ status: 401 });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(operationId, { status: "CANCELLED" });
  });

  it("records nonzero/failed completion without presenting output as success", async () => {
    vi.mocked(adapter.execute).mockResolvedValue({ ...complete, status: "FAILED", data: "private error output" });
    const result = await executeAuthorizedGitOperation(grant, context, mutation, adapter);
    expect(result.status).toBe("FAILED");
    expect(result).not.toHaveProperty("data");
    expect(mocks.finish).toHaveBeenCalledWith(operationId, expect.objectContaining({ status: "FAILED", exitCode: undefined }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("private error output");
  });

  it.each([
    { status: "UNKNOWN" as const, cancellationConfirmed: false, cleanupConfirmed: false },
    { status: "SUCCEEDED" as const, cancellationConfirmed: true, cleanupConfirmed: false },
    { status: "SUCCEEDED" as const, cancellationConfirmed: false, cleanupConfirmed: true },
  ])("retains uncertain outcomes and suppresses output: %j", async outcome => {
    vi.mocked(adapter.execute).mockResolvedValue({ ...outcome, data: "sensitive output" });
    const result = await executeAuthorizedGitOperation(grant, context, mutation, adapter);
    expect(result.status).toBe("UNKNOWN");
    expect(result).not.toHaveProperty("data");
    expect(mocks.finish).toHaveBeenCalledWith(operationId, expect.objectContaining({ status: "UNKNOWN" }));
  });

  it("sanitizes provider failures without automatic retry or false cancellation confirmation", async () => {
    vi.mocked(adapter.execute).mockRejectedValue(new Error("provider-token=secret source contents"));
    const error = await executeAuthorizedGitOperation(grant, context, mutation, adapter).catch(error => error);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toMatch(/secret|source contents/);
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(operationId, { status: "UNKNOWN" });
  });

  it("rejects oversized output instead of reporting truncated success", async () => {
    vi.mocked(adapter.execute).mockResolvedValue({ ...complete, data: "x".repeat(1024 * 1024) });
    await expect(executeAuthorizedGitOperation(grant, context, mutation, adapter)).rejects.toMatchObject({ status: 503 });
    expect(mocks.finish).toHaveBeenCalledWith(operationId, { status: "UNKNOWN" });
  });

  it("withholds completed output when authorization changes during execution", async () => {
    vi.mocked(adapter.execute).mockImplementation(async () => {
      mocks.validate.mockRejectedValue(new ExecutionAuthorizationError(401));
      return { ...complete, data: "private completed output" };
    });
    await expect(executeAuthorizedGitOperation(grant, context, mutation, adapter)).rejects.toMatchObject({ status: 401 });
    expect(mocks.finish).toHaveBeenCalledWith(operationId, { status: "UNKNOWN" });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("private completed output");
  });

  it("does not release output if final persistence cannot confirm the outcome", async () => {
    mocks.finish.mockRejectedValue(new Error("database credential secret"));
    const error = await executeAuthorizedGitOperation(grant, context, mutation, adapter).catch(error => error);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain("secret");
  });

  it("respects request abort, stops output, and leaves dispatch uncertain", async () => {
    vi.mocked(adapter.execute).mockImplementation(async () => {
      controller.abort();
      return noResult();
    });
    await expect(executeAuthorizedGitOperation(grant, context, mutation, adapter)).rejects.toMatchObject({ status: 503 });
    expect(mocks.finish).toHaveBeenCalledWith(operationId, { status: "UNKNOWN" });
    expect(vi.mocked(adapter.execute).mock.calls[0][3].aborted).toBe(true);
  });

  it("bounds remote duration and makes no unsupported cancellation claim", async () => {
    vi.useFakeTimers();
    vi.mocked(adapter.execute).mockImplementation(noResult);
    const pending = executeAuthorizedGitOperation(grant, context, mutation, adapter).catch(error => error);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(await pending).toMatchObject({ status: 503 });
    expect(mocks.finish).toHaveBeenCalledWith(operationId, { status: "UNKNOWN" });
    expect(vi.mocked(adapter.execute).mock.calls[0][3].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects revocation during pending work without high-frequency polling", async () => {
    vi.useFakeTimers();
    vi.mocked(adapter.execute).mockImplementation(noResult);
    const pending = executeAuthorizedGitOperation(grant, context, mutation, adapter).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.execute).toHaveBeenCalledOnce();
    mocks.validate.mockRejectedValue(new ExecutionAuthorizationError(401));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ status: 503 });
    expect(mocks.validate).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.finish).toHaveBeenCalledWith(operationId, { status: "UNKNOWN" });
  });
});

describe("trusted Git adapter factories", () => {
  const scope = (request: GitOperationRequest) => buildGitOperationScope(context, request);

  it("revalidates before reading a GitHub credential and dispatches only canonical repository metadata", async () => {
    const credential = vi.fn(() => "synthetic_token");
    const revalidate = vi.fn().mockResolvedValue(undefined);
    mocks.github.mockResolvedValue({ status: "SUCCEEDED", data: { branches: [] } });
    const request = parseGitOperation({ operation: "list-branches" });
    const result = await createGithubGitAdapter(credential).execute(request, scope(request), revalidate, context.signal);
    expect(result.status).toBe("SUCCEEDED");
    expect(revalidate.mock.invocationCallOrder[0]).toBeLessThan(credential.mock.invocationCallOrder[0]);
    expect(mocks.github).toHaveBeenCalledWith(expect.objectContaining({ repository: { owner: "badadeveloper001-dev", repo: "cr8or-studio" },
      token: "synthetic_token", operation: { kind: "branches" }, revalidate, signal: context.signal }));
    expect(JSON.stringify(result)).not.toContain("synthetic_token");
  });

  it("does not read credentials or dispatch after authorization fails", async () => {
    const credential = vi.fn(() => "synthetic_token");
    await expect(createGithubGitAdapter(credential).execute(push, scope(push), async () => { throw new ExecutionAuthorizationError(401); }, context.signal)).rejects.toMatchObject({ status: 401 });
    expect(credential).not.toHaveBeenCalled();
    expect(mocks.github).not.toHaveBeenCalled();
  });

  it("fails closed when a dedicated server credential is missing", async () => {
    await expect(createGithubGitAdapter(() => undefined).execute(push, scope(push), async () => undefined, context.signal)).rejects.toMatchObject({ status: 503 });
    expect(mocks.github).not.toHaveBeenCalled();
  });

  it("preserves exact push and branch creation targets", async () => {
    mocks.github.mockResolvedValue({ status: "SUCCEEDED" });
    const github = createGithubGitAdapter(() => "synthetic_token");
    await github.execute(push, scope(push), async () => undefined, context.signal);
    expect(mocks.github).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { kind: "advance-branch", branch: "main", expectedHead: head, targetCommit: otherHead } }));
    const branch = parseGitOperation({ operation: "create-branch", branch: "main", expectedRemoteHead: head, targetCommit: head, targetBranch: "feature/new" });
    await github.execute(branch, scope(branch), async () => undefined, context.signal);
    expect(mocks.github).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { kind: "create-branch", branch: "feature/new", fromBranch: "main", expectedHead: head } }));
    const mismatched = parseGitOperation({ ...branch, targetCommit: otherHead });
    await expect(github.execute(mismatched, scope(mismatched), async () => undefined, context.signal)).rejects.toMatchObject({ status: 409 });
    expect(mocks.github).toHaveBeenCalledTimes(2);
  });

  it("retains exact PR targets and delegates only the approved category to trusted title generation", async () => {
    mocks.github.mockResolvedValue({ status: "SUCCEEDED" });
    const request = parseGitOperation({ operation: "create-pr", branch: "main", expectedRemoteHead: head,
      baseBranch: "review", expectedBase: otherHead, category: "Code improvements" });
    const registered = { ...context, workspace: { ...workspace, repositoryUrl: "https://github.com/badadeveloper001-dev/Cr8or-Studio.git" } };
    await createGithubGitAdapter(() => "synthetic_token").execute(request, buildGitOperationScope(registered, request), async () => undefined, context.signal);
    expect(mocks.github).toHaveBeenCalledWith(expect.objectContaining({ operation: expect.objectContaining({
      kind: "create-pr", branch: "main", base: "review", expectedHead: head, expectedBase: otherHead, category: "Code improvements",
    }) }));
    expect(mocks.github.mock.calls[0][0].operation).not.toHaveProperty("title");
  });

  it("derives neutral sequential commit titles from the verified project-wide sequence", async () => {
    mocks.github.mockResolvedValueOnce({ status: "SUCCEEDED", data: { head, projectCode: "CR8OR", nextSequence: 11 } }).mockResolvedValueOnce({ status: "SUCCEEDED", data: { head: otherHead } });
    const result = await createGithubGitAdapter(() => "synthetic_token").execute(update, scope(update), async () => undefined, context.signal);
    expect(result.status).toBe("SUCCEEDED");
    expect(mocks.github).toHaveBeenNthCalledWith(1, expect.objectContaining({ operation: { kind: "commit-sequence", branch: "main", expectedHead: head } }));
    expect(mocks.github).toHaveBeenNthCalledWith(2, expect.objectContaining({ operation: expect.objectContaining({
      kind: "update-file", message: "CR8OR-011: Code improvements", expectedHead: head,
      path: "src/app.ts", expectedFileSha: null, content: "private synthetic fixture content",
    }) }));
  });

  it.each([
    { status: "FAILED" }, { status: "UNKNOWN" },
    { status: "SUCCEEDED" },
    { status: "SUCCEEDED", data: { head: otherHead, projectCode: "CR8OR", nextSequence: 11 } },
    { status: "SUCCEEDED", data: { head } },
    { status: "SUCCEEDED", data: { head, nextSequence: 11 } },
    { status: "SUCCEEDED", data: { head, projectCode: "UNRELATED", nextSequence: 11 } },
    { status: "SUCCEEDED", data: { head, projectCode: "CR8OR", nextSequence: 1_000_000_000 } },
    { status: "SUCCEEDED", data: { head, projectCode: "CR8OR", nextSequence: 0 } },
    { status: "SUCCEEDED", data: { head, projectCode: "CR8OR", nextSequence: -1 } },
    { status: "SUCCEEDED", data: { head, projectCode: "CR8OR", nextSequence: 1.5 } },
    { status: "SUCCEEDED", data: { head, projectCode: "CR8OR", nextSequence: "11" } },
    { status: "SUCCEEDED", data: { head, projectCode: "CR8OR", nextSequence: Number.NaN } },
    { status: "SUCCEEDED", data: { head, projectCode: "CR8OR", nextSequence: Number.POSITIVE_INFINITY } },
    { status: "SUCCEEDED", data: { complete: true, commits: [{ sha: head, sequence: 10 }] } },
  ])("rejects unverified commit numbering without mutating remote files: %#", async history => {
    mocks.github.mockResolvedValue(history);
    await expect(createGithubGitAdapter(() => "synthetic_token").execute(update, scope(update), async () => undefined, context.signal)).rejects.toMatchObject({ status: 409 });
    expect(mocks.github).toHaveBeenCalledOnce();
  });

  it("does not claim cancellation or cleanup for an ambiguous GitHub outcome", async () => {
    mocks.github.mockResolvedValue({ status: "UNKNOWN" });
    expect(await createGithubGitAdapter(() => "synthetic_token").execute(push, scope(push), async () => undefined, context.signal))
      .toEqual({ status: "UNKNOWN", data: undefined, cancellationConfirmed: false, cleanupConfirmed: false });
  });

  it("resolves only the exact authorized Daytona sandbox and revalidates before the fixed session protocol", async () => {
    const process = { fixture: "controlled process adapter" };
    const provider = { getPrivateGitSessionProcess: vi.fn().mockResolvedValue(process) };
    const revalidate = vi.fn().mockResolvedValue(undefined);
    mocks.session.mockResolvedValue(complete);
    expect(await createDaytonaGitAdapter(provider as unknown as DaytonaProvider).execute(mutation, scope(mutation), revalidate, context.signal)).toEqual(complete);
    expect(provider.getPrivateGitSessionProcess).toHaveBeenCalledExactlyOnceWith("sandbox-a");
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(mocks.session).toHaveBeenCalledExactlyOnceWith(process, mutation, scope(mutation), revalidate, context.signal);
  });

  it("cannot reach Daytona after authorization is revoked", async () => {
    const provider = { getPrivateGitSessionProcess: vi.fn() };
    await expect(createDaytonaGitAdapter(provider as unknown as DaytonaProvider).execute(mutation, scope(mutation),
      async () => { throw new ExecutionAuthorizationError(401); }, context.signal)).rejects.toMatchObject({ status: 401 });
    expect(provider.getPrivateGitSessionProcess).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
