import "server-only";

import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@/lib/security/audit";
import { ExecutionAuthorizationError, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { validateGitAuthorization, type GitAuthorization } from "@/lib/security/git-authorization";
import { buildGitOperationScope, canonicalGitRepository, gitScopeDigest, isGithubOperation, isGitMutation, parseGitOperation, validateGitOperationScope, type GitOperationRequest, type GitOperationScope } from "@/lib/security/git-operation-catalogue";
import { validateGitObjectTransfer } from "@/lib/security/git-object-transfer";
import { reserveGitOperation, markGitDispatched, finishGitOperation } from "@/lib/security/git-operation-store";
import { formatGitPullTitle, resolveGitProjectCode } from "@/lib/security/git-project-naming";
import { executePrivateGithubOperation, type PrivateGithubOperation } from "@/lib/workspace/private-github-api";
import { privateGitObjectSession, privateGitSession } from "@/lib/workspace/private-git-session";
import { executePrivateGithubObjectTransfer } from "@/lib/workspace/private-github-object-transfer";
import type { DaytonaProvider } from "@/lib/workspace/providers/daytona";

export type GitTransportResult = { status: "SUCCEEDED" | "FAILED" | "UNKNOWN"; data?: unknown; cancellationConfirmed: boolean; cleanupConfirmed: boolean };
/** Server-owned transport factories only. No HTTP/tool input accepts an adapter. */
export type GitExecutionAdapter = {
  kind: "github" | "daytona";
  execute: (request: GitOperationRequest, scope: GitOperationScope, revalidate: () => Promise<void>, signal: AbortSignal) => Promise<GitTransportResult>;
};
const unavailable = () => new ExecutionAuthorizationError(503, "Git operation could not be verified. Operator reconciliation may be required.");

/** Isolated mechanism behind the application release gate. A real opaque grant
 * and current PostgreSQL state are still mandatory; no environment bypass. */
export async function executeAuthorizedGitOperation(grant: GitAuthorization, context: ExecutionAuthorizationContext,
  input: GitOperationRequest, adapter: GitExecutionAdapter): Promise<GitTransportResult & { operationId: string }> {
  const request = parseGitOperation(input);
  if (adapter.kind !== (isGithubOperation(request.operation) ? "github" : "daytona")) throw new ExecutionAuthorizationError(403);
  const metadata = await validateGitAuthorization(grant, context, request);
  const mutation = isGitMutation(request.operation);
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let reserved = false, dispatched = false, finished = false;
  let validation: Promise<void> | undefined;
  let authorizationFailure = false;
  const revalidate = async () => {
    if (signal.aborted || authorizationFailure) throw new ExecutionAuthorizationError(401);
    if (!validation) validation = validateGitAuthorization(grant, context, request).then(() => undefined).catch((error) => {
      authorizationFailure = true; controller.abort(); throw error;
    }).finally(() => { validation = undefined; });
    await validation;
    if (signal.aborted) throw new ExecutionAuthorizationError(401);
  };
  const audit = (status: string) => appendAuditEvent({ id: randomUUID(), at: new Date().toISOString(), actorId: metadata.actorId,
    actorRole: metadata.actorId === "owner" ? "owner" : "agent", action: "sandbox.run",
    outcome: status === "RUNNING" || status === "SUCCEEDED" ? "allow" : "error", reason: "private Git operation",
    metadata: { operationId: metadata.operationId, projectId: metadata.scope.projectId,
      operation: metadata.scope.operationKey, status } });
  const poll = setInterval(() => { void revalidate().catch(() => undefined); }, 2000);
  let abortListener: (() => void) | undefined;
  try {
    if (mutation) {
      await reserveGitOperation({ id: metadata.operationId, executionId: metadata.executionId, actorId: metadata.actorId,
        projectId: metadata.scope.projectId, workspaceId: metadata.scope.providerWorkspaceId, repositoryKey: metadata.scope.repositoryKey,
        operationKey: metadata.scope.operationKey, scopeDigest: gitScopeDigest(metadata.scope) });
      reserved = true;
    }
    await revalidate();
    if (mutation) { await markGitDispatched(metadata.operationId); dispatched = true; }
    await revalidate();
    audit("RUNNING");
    const result = await Promise.race([
      adapter.execute(request, metadata.scope, revalidate, signal),
      new Promise<never>((_, reject) => {
        abortListener = () => reject(unavailable());
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      }),
    ]);
    await revalidate();
    if (!result || !["SUCCEEDED", "FAILED", "UNKNOWN"].includes(result.status) ||
        typeof result.cancellationConfirmed !== "boolean" || typeof result.cleanupConfirmed !== "boolean" ||
        Buffer.byteLength(JSON.stringify(result), "utf8") > 1024 * 1024) throw unavailable();
    // Positive remote completion and cleanup evidence are required to free a
    // mutation reservation. A disconnected caller never gets a false success.
    const status = result.cancellationConfirmed && result.cleanupConfirmed ? result.status : "UNKNOWN";
    if (mutation) {
      await finishGitOperation(metadata.operationId, { status, exitCode: status === "SUCCEEDED" ? 0 : undefined,
        cancellationConfirmed: result.cancellationConfirmed, cleanupConfirmed: result.cleanupConfirmed });
      finished = true;
    }
    await revalidate();
    audit(status);
    return { operationId: metadata.operationId, status, cancellationConfirmed: result.cancellationConfirmed,
      cleanupConfirmed: result.cleanupConfirmed, ...(status === "SUCCEEDED" ? { data: result.data } : {}) };
  } catch (error) {
    controller.abort();
    if (reserved && !finished) {
      try { await finishGitOperation(metadata.operationId, { status: dispatched ? "UNKNOWN" : "CANCELLED" }); }
      catch { throw unavailable(); }
    }
    audit(dispatched ? "UNKNOWN" : "CANCELLED");
    if (error instanceof ExecutionAuthorizationError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timeout); clearInterval(poll);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export function createDaytonaGitAdapter(provider: DaytonaProvider): GitExecutionAdapter {
  return { kind: "daytona", execute: async (request, scope, revalidate, signal) => {
    await revalidate();
    // The provider independently verifies exact ID and conservative isolation
    // metadata. No start, clone, recovery or local-host fallback is permitted.
    const process = await provider.getPrivateGitSessionProcess(scope.providerWorkspaceId);
    await revalidate();
    return privateGitSession(process, request, scope, revalidate, signal);
  } };
}

/** Credentials stay on the application server and only reach fixed GitHub HTTPS
 * headers. The release gate remains closed pending least-privilege verification. */
export function createGithubGitAdapter(token: () => string | undefined, fetcher?: typeof fetch): GitExecutionAdapter {
  return { kind: "github", execute: async (request, scope, revalidate, signal) => {
    await revalidate();
    // Push must prove the local objects in the registered sandbox; a remote-only
    // adapter is never a fallback when that transfer cannot be verified.
    if (request.operation === "push") throw unavailable();
    if (request.operation === "create-pr" || request.operation === "upsert-file") {
      // Reconstruct the approved inputs and naming policy before credentials.
      // The PR title is fixed by its approved head; file-update numbering is
      // separately checked against verified history before mutation.
      const intended = buildGitOperationScope({ projectId: scope.projectId, workspace: {
        id: scope.workspaceRecordId, runtimeType: "cloud", provider: "daytona",
        providerWorkspaceId: scope.providerWorkspaceId, repositoryUrl: `https://github.com/${scope.repositoryKey}`,
        branch: scope.branch,
      } }, request);
      if (gitScopeDigest(intended) !== gitScopeDigest(scope)) throw new ExecutionAuthorizationError(403);
    }
    const credential = token();
    if (!credential) throw unavailable();
    const repository = canonicalGitRepository(`https://github.com/${scope.repositoryKey}`);
    const run = (operation: PrivateGithubOperation) => executePrivateGithubOperation({ repository: { owner: repository.owner, repo: repository.repo },
      operation, token: credential, revalidate, signal, fetch: fetcher });
    let operation: PrivateGithubOperation;
    switch (request.operation) {
      case "list-branches": operation = { kind: "branches" }; break;
      case "list-contents": operation = { kind: "contents", branch: scope.branch, path: request.filePath }; break;
      case "read-file": operation = { kind: "read-file", branch: scope.branch, path: request.filePath }; break;
      case "pr-checks": operation = { kind: "pr-checks", branch: scope.branch, pullNumber: request.pullNumber }; break;
      case "create-branch":
        if (request.targetCommit !== request.expectedRemoteHead) throw new ExecutionAuthorizationError(409);
        operation = { kind: "create-branch", branch: request.targetBranch, fromBranch: scope.branch, expectedHead: request.expectedRemoteHead }; break;
      case "create-pr": operation = { kind: "create-pr", branch: scope.branch, base: request.baseBranch,
        expectedHead: request.expectedRemoteHead, expectedBase: request.expectedBase, category: request.category, body: "Created through an authorized Cr8or Studio operation." }; break;
      case "upsert-file": {
        const history = await run({ kind: "commit-sequence", branch: scope.branch, expectedHead: request.expectedRemoteHead });
        const projectCode = resolveGitProjectCode(scope.repositoryKey);
        const data = history.data as { head?: string; projectCode?: string; nextSequence?: number } | undefined;
        if (history.status !== "SUCCEEDED" || data?.head !== request.expectedRemoteHead ||
            data.projectCode !== projectCode ||
            !Number.isSafeInteger(data.nextSequence) || data.nextSequence! < 1 || data.nextSequence! > 999_999_999) {
          throw new ExecutionAuthorizationError(409, "Commit sequence cannot be verified.");
        }
        const sequence = data.nextSequence!;
        operation = { kind: "update-file", branch: scope.branch, expectedHead: request.expectedRemoteHead, path: request.filePath,
          expectedFileSha: request.expectedBlob, content: request.content, message: formatGitPullTitle(projectCode, sequence, request.category) }; break;
      }
      default: throw new ExecutionAuthorizationError(403);
    }
    const result = await run(operation);
    return { status: result.status, data: result.data,
      cancellationConfirmed: result.status !== "UNKNOWN", cleanupConfirmed: result.status !== "UNKNOWN" };
  } };
}

/** One approved push spans exact-sandbox export, independent object validation,
 * GitHub object creation and the existing non-force branch advance. The caller
 * keeps the same opaque grant and durable reservation throughout every step. */
export function createGithubObjectTransferAdapter(provider: DaytonaProvider,
  token: () => string | undefined, fetcher?: typeof fetch): GitExecutionAdapter {
  return { kind: "github", execute: async (input, proposedScope, revalidate, signal) => {
    await revalidate();
    if (signal.aborted) throw new ExecutionAuthorizationError(401);
    const request = parseGitOperation(input);
    const scope = validateGitOperationScope(proposedScope);
    if (request.operation !== "push") throw new ExecutionAuthorizationError(403);
    const intended = buildGitOperationScope({ projectId: scope.projectId, workspace: {
      id: scope.workspaceRecordId, runtimeType: "cloud", provider: "daytona",
      providerWorkspaceId: scope.providerWorkspaceId, repositoryUrl: `https://github.com/${scope.repositoryKey}`,
      branch: scope.branch,
    } }, request);
    if (gitScopeDigest(intended) !== gitScopeDigest(scope)) throw new ExecutionAuthorizationError(403);
    const process = await provider.getPrivateGitSessionProcess(scope.providerWorkspaceId);
    await revalidate();
    if (signal.aborted) throw new ExecutionAuthorizationError(401);
    const exported = await privateGitObjectSession(process, request, scope, revalidate, signal);
    await revalidate();
    if (exported.status !== "SUCCEEDED" || !exported.cancellationConfirmed || !exported.cleanupConfirmed) {
      return { status: exported.status === "FAILED" && exported.cancellationConfirmed && exported.cleanupConfirmed ? "FAILED" : "UNKNOWN",
        cancellationConfirmed: exported.cancellationConfirmed, cleanupConfirmed: exported.cleanupConfirmed };
    }
    // Source bytes and object records are internal only, never a tool receipt.
    validateGitObjectTransfer(exported.data, scope);
    await revalidate();
    if (signal.aborted) throw new ExecutionAuthorizationError(401);
    const credential = token();
    if (!credential) throw unavailable();
    return executePrivateGithubObjectTransfer({ scope, graph: exported.data, token: credential,
      revalidate, signal, fetch: fetcher });
  } };
}
