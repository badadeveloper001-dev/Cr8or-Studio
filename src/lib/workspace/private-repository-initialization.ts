import "server-only";

import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { validateRepositoryInitialization } from "@/lib/security/git-repository-initialization";
import { validateWorkspaceLifecycleScope, workspaceLifecycleScopeDigest, type WorkspaceLifecycleScope } from "@/lib/security/workspace-lifecycle-catalogue";
import { downloadPrivateGithubRepository, resolvePrivateGithubRepositoryHead } from "@/lib/workspace/private-github-repository-source";
import { privateRepositorySession } from "@/lib/workspace/private-repository-session";
import type { RepositoryInitializationEvidence, RepositoryInitializationTransport } from "@/lib/workspace/private-workspace-lifecycle";
import type { DaytonaProvider } from "@/lib/workspace/providers/daytona";

const unavailable = () => new ExecutionAuthorizationError(503, "Repository initialization could not be verified.");
const providerId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Provider = Pick<DaytonaProvider, "getPrivateGitSessionProcess">;
type Graph = Awaited<ReturnType<typeof downloadPrivateGithubRepository>>;

/** Trusted server composition only. Routes cannot supply adapters, credentials,
 * scope claims or validation callbacks. The lifecycle service owns approvals,
 * reservations and the hardcoded release restriction. This instance buffers at
 * most one bounded graph, never an authentication or authorization decision. */
export function createPrivateRepositoryInitializationTransport(provider: Provider,
  token: () => string | undefined, fetcher?: typeof fetch): RepositoryInitializationTransport {
  let prepared: { digest: string; graph: Graph } | undefined;
  const check = async (revalidate: () => Promise<void>, signal?: AbortSignal) => {
    if (signal?.aborted || typeof revalidate !== "function") throw new ExecutionAuthorizationError(401);
    await revalidate();
    if (signal?.aborted) throw new ExecutionAuthorizationError(401);
  };
  const credential = () => {
    const value = token();
    if (!value) throw unavailable();
    return value;
  };
  function binding(input: WorkspaceLifecycleScope) {
    const scope = validateWorkspaceLifecycleScope(input);
    if (scope.action !== "clone" || !scope.initialization || !scope.repositoryKey || !scope.branch || scope.providerWorkspaceId !== null) {
      throw new ExecutionAuthorizationError(403);
    }
    return { scope, repositoryKey: scope.repositoryKey, branch: scope.branch, head: scope.initialization.expectedHead };
  }
  const head = async (repository: { repositoryKey: string; branch: string }, revalidate: () => Promise<void>, signal?: AbortSignal) => {
    await check(revalidate, signal);
    const value = await resolvePrivateGithubRepositoryHead({ ...repository, token: credential(), revalidate, signal, fetch: fetcher });
    await check(revalidate, signal);
    return value;
  };
  const currentHead = async (scope: WorkspaceLifecycleScope, revalidate: () => Promise<void>, signal?: AbortSignal) => {
    const bound = binding(scope);
    if (await head(bound, revalidate, signal) !== bound.head) throw new ExecutionAuthorizationError(409, "Repository state changed.");
  };
  const prepare = async (input: WorkspaceLifecycleScope, revalidate: () => Promise<void>, signal?: AbortSignal) => {
    await check(revalidate, signal);
    const bound = binding(input);
    const graph = await downloadPrivateGithubRepository({ repositoryKey: bound.repositoryKey, branch: bound.branch,
      head: bound.head, token: credential(), revalidate, signal, fetch: fetcher });
    validateRepositoryInitialization(graph, { repositoryKey: bound.repositoryKey, branch: bound.branch, head: bound.head });
    await check(revalidate, signal);
    prepared = { digest: workspaceLifecycleScopeDigest(bound.scope), graph };
  };
  const processFor = async (id: string, revalidate: () => Promise<void>, signal?: AbortSignal) => {
    await check(revalidate, signal);
    if (!providerId.test(id)) throw new ExecutionAuthorizationError(403);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      // SDK requestTimeoutMs also bounds real transport; this deadline covers
      // an adapter that never settles. No lifecycle mutation or fallback occurs.
      const process = await Promise.race([provider.getPrivateGitSessionProcess(id), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), 5_000);
        abort = () => reject(new ExecutionAuthorizationError(401));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      })]);
      await check(revalidate, signal);
      return process;
    } catch (error) {
      if (error instanceof ExecutionAuthorizationError) throw error;
      throw unavailable();
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  };
  const perform = async (input: WorkspaceLifecycleScope, operationId: string, id: string,
    revalidate: () => Promise<void>, signal: AbortSignal | undefined, mode: "initialize" | "inspect"): Promise<RepositoryInitializationEvidence> => {
    await check(revalidate, signal);
    const bound = binding(input);
    if (!providerId.test(operationId) || !providerId.test(id)) throw new ExecutionAuthorizationError(403);
    const digest = workspaceLifecycleScopeDigest(bound.scope);
    if (prepared?.digest !== digest) await prepare(bound.scope, revalidate, signal);
    const graph = prepared?.graph;
    if (!graph || prepared?.digest !== digest) throw unavailable();
    validateRepositoryInitialization(graph, { repositoryKey: bound.repositoryKey, branch: bound.branch, head: bound.head });
    await currentHead(bound.scope, revalidate, signal);
    const metadata = { operationId, projectId: bound.scope.projectId, workspaceRecordId: bound.scope.workspaceRecordId,
      providerWorkspaceId: id, repositoryKey: bound.repositoryKey, branch: bound.branch, head: bound.head };
    const run = async (action: "initialize" | "inspect") => {
      const process = await processFor(id, revalidate, signal);
      const result = await privateRepositorySession(process, metadata, graph, revalidate, signal ?? new AbortController().signal, action);
      await check(revalidate, signal);
      if (result.status !== "SUCCEEDED" || !result.cleanupConfirmed || !result.cancellationConfirmed) throw unavailable();
      return result;
    };
    const result = await run(mode);
    if (mode === "initialize" && result.state !== "READY") throw unavailable();
    // The lifecycle service separately invokes inspect with a fresh exact-ID
    // lookup before registration. This method never marks a workspace ready.
    await currentHead(bound.scope, revalidate, signal);
    await check(revalidate, signal);
    const complete = result.state === "READY" && result.head === bound.head && result.branch === bound.branch;
    if (result.state === "READY" && !complete) throw unavailable();
    return { status: complete ? "complete" : result.state === "ABSENT" ? "absent" : result.state === "INCOMPLETE" ? "incomplete" : "mismatched",
      repositoryKey: bound.repositoryKey, branch: bound.branch, head: complete ? bound.head : null, historyVerified: complete };
  };
  const transport: RepositoryInitializationTransport = { resolveHead: head, prepare,
    initialize: (scope, operationId, id, revalidate, signal) => perform(scope, operationId, id, revalidate, signal, "initialize"),
    inspect: (scope, operationId, id, revalidate, signal) => perform(scope, operationId, id, revalidate, signal, "inspect"),
  };
  return Object.freeze(transport);
}
