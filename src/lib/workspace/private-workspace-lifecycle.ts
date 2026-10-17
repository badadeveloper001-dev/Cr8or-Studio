import "server-only";

import { prisma } from "@/lib/db/prisma";
import { resolvePrivateOwnerBinding, type AuthSession, type PrivateOwnerSessionBinding } from "@/lib/security/auth";
import { createExecutionAuthorization, ExecutionAuthorizationError, revalidateExecutionAuthorization } from "@/lib/security/execution-context";
import { canonicalGitRepository } from "@/lib/security/git-operation-catalogue";
import { getPolicyProfile } from "@/lib/security/policy";
import { parseWorkspaceLifecycleRequest, reservedLifecycleIdentity, validateWorkspaceLifecycleScope,
  workspaceLifecycleScopeDigest, type WorkspaceLifecycleRequest, type WorkspaceLifecycleScope } from "@/lib/security/workspace-lifecycle-catalogue";
import * as store from "@/lib/security/workspace-lifecycle-store";
import { assertLifecycleResourceIdentity, assertLifecycleResourceIsolation, assertNewLifecycleResource, createPrivateLifecycleProvider,
  type LifecycleProvider, type LifecycleResource } from "@/lib/workspace/private-lifecycle-provider";
import { assertPrivateRepositoryCloningAvailable, assertWorkspaceLifecycleAvailable } from "@/lib/workspace/private-workspace-lifecycle-availability";

export const WORKSPACE_LIFECYCLE_LIMITS = Object.freeze({ durationMs: 60_000, revalidationMs: 2_000 });

/** Internal server composition only; never selected by request/configuration.
 * Implementations validate complete raw objects, and inspection cannot mutate. */
export type RepositoryInitializationEvidence = Readonly<{
  status: "complete" | "absent" | "incomplete" | "mismatched";
  repositoryKey: string; branch: string; head: string | null; historyVerified: boolean;
}>;
export interface RepositoryInitializationTransport {
  resolveHead(repository: Readonly<{ repositoryKey: string; branch: string }>, revalidate: () => Promise<void>, signal?: AbortSignal): Promise<string>;
  prepare(scope: WorkspaceLifecycleScope, revalidate: () => Promise<void>, signal?: AbortSignal): Promise<void>;
  initialize(scope: WorkspaceLifecycleScope, operationId: string, providerWorkspaceId: string,
    revalidate: () => Promise<void>, signal?: AbortSignal): Promise<RepositoryInitializationEvidence>;
  inspect(scope: WorkspaceLifecycleScope, operationId: string, providerWorkspaceId: string,
    revalidate: () => Promise<void>, signal?: AbortSignal): Promise<RepositoryInitializationEvidence>;
}

async function owner(session: AuthSession, signal?: AbortSignal): Promise<PrivateOwnerSessionBinding> {
  try {
    if (signal?.aborted) throw new ExecutionAuthorizationError(401);
    const binding = await resolvePrivateOwnerBinding(session);
    if (!binding || signal?.aborted) throw new ExecutionAuthorizationError(401);
    return binding;
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) throw error;
    throw new ExecutionAuthorizationError(503, "Workspace authorization is unavailable.");
  }
}

async function registeredScope(session: AuthSession, projectId: string, action: "start" | "stop", signal?: AbortSignal) {
  const context = await createExecutionAuthorization(session, projectId, { permissions: ["manage"], signal });
  if (!context || context.workspace.runtimeType !== "cloud" || context.workspace.provider !== "daytona" ||
      !context.workspace.id || !context.workspace.providerWorkspaceId) throw new ExecutionAuthorizationError(409);
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, repository: true } });
  if (!project) throw new ExecutionAuthorizationError(404);
  const repository = context.workspace.repositoryUrl ? canonicalGitRepository(context.workspace.repositoryUrl) : null;
  if (repository ? !project.repository || canonicalGitRepository(project.repository).key !== repository.key : !!project.repository) {
    throw new ExecutionAuthorizationError(409);
  }
  await revalidateExecutionAuthorization(context, projectId, "manage");
  return validateWorkspaceLifecycleScope({ version: 1, ownerId: "owner", action, projectId,
    workspaceRecordId: context.workspace.id, providerWorkspaceId: context.workspace.providerWorkspaceId,
    projectName: project.name, repositoryKey: repository?.key ?? null, repositoryUrl: repository?.url ?? null,
    branch: context.workspace.branch });
}

async function resolveScope(session: AuthSession, request: WorkspaceLifecycleRequest, signal?: AbortSignal,
  transport?: RepositoryInitializationTransport, pinnedInitialization?: WorkspaceLifecycleScope["initialization"]) {
  const binding = await owner(session, signal);
  if (request.action === "start" || request.action === "stop") return registeredScope(session, request.projectId, request.action, signal);
  const repository = request.action === "clone" ? canonicalGitRepository(request.repositoryUrl) : null;
  let initialization: WorkspaceLifecycleScope["initialization"];
  if (request.action === "clone") {
    if (!transport) assertPrivateRepositoryCloningAvailable();
    initialization = pinnedInitialization ?? { version: 1, strategy: "complete-sha1-git-database", expectedHead:
      await transport!.resolveHead({ repositoryKey: repository!.key, branch: request.branch }, async () => { await owner(session, signal); }, signal) };
    await owner(session, signal);
  }
  return validateWorkspaceLifecycleScope({ version: 1, ownerId: "owner", action: request.action,
    ...reservedLifecycleIdentity(binding.sessionId, request.idempotencyKey), providerWorkspaceId: null,
    projectName: request.projectName ?? repository!.repo, repositoryKey: repository?.key ?? null,
    repositoryUrl: repository?.url ?? null, branch: request.action === "clone" ? request.branch : null,
    ...(initialization ? { initialization } : {}) });
}

/** Never return session references, credential generations or raw DB rows. */
function operationView(operation: Awaited<ReturnType<typeof store.readLifecycleOperation>>) {
  if (!operation) throw new ExecutionAuthorizationError(404);
  return { ok: operation.status === "SUCCEEDED", operationId: operation.id, projectId: operation.projectId,
    action: operation.action, status: operation.status, createdAt: operation.createdAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null };
}
function approvalView(approval: Awaited<ReturnType<typeof store.createLifecycleApproval>> | null) {
  if (!approval) throw new ExecutionAuthorizationError(404);
  const scope = validateWorkspaceLifecycleScope(approval.scope);
  return { ok: true, approvalId: approval.id, status: approval.status, expiresAt: approval.expiresAt,
    scope, preview: { action: scope.action, projectId: scope.projectId, projectName: scope.projectName,
      workspaceRecordId: scope.workspaceRecordId, providerWorkspaceId: scope.providerWorkspaceId,
      repositoryUrl: scope.repositoryUrl, branch: scope.branch,
      ...(scope.initialization ? { expectedHead: scope.initialization.expectedHead } : {}) } };
}

export async function prepareWorkspaceLifecycle(session: AuthSession, input: unknown, signal?: AbortSignal) {
  const binding = await owner(session, signal);
  const request = parseWorkspaceLifecycleRequest(input);
  let transport: RepositoryInitializationTransport | undefined;
  if (request.action === "clone") {
    assertPrivateRepositoryCloningAvailable();
    transport = await configuredRepositoryTransport();
  }
  const scope = await resolveScope(session, request, signal, transport);
  return approvalView(await store.createLifecycleApproval(binding, scope));
}
/** Tests compose the verified source transport explicitly; public clone approval
 * remains blocked until provider verification and a reviewed release change. */
export async function prepareWorkspaceLifecycleWithRepository(session: AuthSession, input: unknown,
  transport: RepositoryInitializationTransport, signal?: AbortSignal) {
  const binding = await owner(session, signal);
  const request = parseWorkspaceLifecycleRequest(input);
  const scope = await resolveScope(session, request, signal, transport);
  return approvalView(await store.createLifecycleApproval(binding, scope));
}
export async function decideWorkspaceLifecycle(session: AuthSession, id: string, decision: "approve" | "reject") {
  const binding = await owner(session);
  if (decision !== "approve" && decision !== "reject") throw new ExecutionAuthorizationError(403);
  return approvalView(await store.decideLifecycleApproval(binding, id, decision === "approve" ? "approved" : "denied"));
}
export async function readWorkspaceLifecycle(session: AuthSession, id: string) {
  return operationView(await store.readLifecycleOperation(await owner(session), id));
}

/** Bounded, low-frequency revalidation during an external wait. Cancellation
 * stops subsequent dispatch/output; it does not claim to undo provider work. */
async function authorizedWait<T>(session: AuthSession, signal: AbortSignal | undefined,
  validate: (signal: AbortSignal) => Promise<void>, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let finished = false;
  const check = async () => { await owner(session, combined); await validate(combined); };
  try {
    await check();
    return await Promise.race([work(combined), new Promise<never>((_, reject) => {
      onAbort = () => reject(new ExecutionAuthorizationError(401));
      combined.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new ExecutionAuthorizationError(503, "Workspace operation timed out.")), WORKSPACE_LIFECYCLE_LIMITS.durationMs);
      const tick = async () => {
        try { await check(); } catch (error) { reject(error); return; }
        if (!finished) poll = setTimeout(() => void tick(), WORKSPACE_LIFECYCLE_LIMITS.revalidationMs);
      };
      poll = setTimeout(() => void tick(), WORKSPACE_LIFECYCLE_LIMITS.revalidationMs);
      if (combined.aborted) onAbort();
    })]);
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    if (poll) clearTimeout(poll);
    if (onAbort) combined.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

function evidence(scope: WorkspaceLifecycleScope, operationId: string, resource: LifecycleResource,
  initialized?: RepositoryInitializationEvidence): store.VerifiedLifecycleResource {
  if (resource.state !== "started" && resource.state !== "stopped") throw new ExecutionAuthorizationError(409);
  if ((scope.action === "stop" ? "stopped" : "started") !== resource.state) throw new ExecutionAuthorizationError(409);
  // A stopped historical resource need not qualify for private execution.
  // Every transition to ready requires positive, server-derived isolation evidence.
  if (scope.action !== "stop") assertLifecycleResourceIsolation(resource, scope.providerWorkspaceId ?? resource.id);
  if (scope.action === "clone" && (!initialized || initialized.status !== "complete" || initialized.historyVerified !== true ||
      initialized.repositoryKey !== scope.repositoryKey || initialized.branch !== scope.branch ||
      initialized.head !== scope.initialization?.expectedHead)) {
    throw new ExecutionAuthorizationError(409, "Repository initialization remains unresolved.");
  }
  return { id: resource.id, state: resource.state, isolationVerified: resource.isolationVerified,
    repositoryKey: scope.repositoryKey, branch: scope.branch,
    reservationId: operationId, projectId: scope.projectId,
    ...(scope.action === "clone" ? { repositoryInitialization: { status: "complete" as const,
      repositoryKey: scope.repositoryKey!, branch: scope.branch!, head: initialized!.head!, historyVerified: true as const } } : {}) };
}

/** Trusted composition seam for disposable adapter tests. Routes use only the
 * release-gated facade below. There is no request/environment adapter selector. */
export async function executeWorkspaceLifecycleWithProvider(session: AuthSession, input: unknown, provider: LifecycleProvider,
  approvalId?: string, signal?: AbortSignal, repositoryTransport?: RepositoryInitializationTransport) {
  const binding = await owner(session, signal);
  const request = parseWorkspaceLifecycleRequest(input);
  const scope = await resolveScope(session, request, signal, repositoryTransport);
  const profile = getPolicyProfile();
  const reservation = await store.reserveLifecycleOperation(binding, scope, {
    idempotencyKey: request.idempotencyKey, approvalId, requiresApproval: profile !== "autonomous",
  });
  const operation = reservation.operation;
  if (reservation.reused) return operationView(operation);
  let dispatched = false;
  try {
    const validate = async (currentSignal: AbortSignal) => {
      const current = await resolveScope(session, request, currentSignal, repositoryTransport, scope.initialization);
      if (workspaceLifecycleScopeDigest(current) !== workspaceLifecycleScopeDigest(scope)) throw new ExecutionAuthorizationError(409);
      if (getPolicyProfile() !== profile) throw new ExecutionAuthorizationError(409);
      if (dispatched) await store.assertLifecycleDispatch(await owner(session, currentSignal), operation.id);
    };
    const result = await authorizedWait(session, signal, validate, async (currentSignal) => {
      // Exact current identity is verified before a start/stop dispatch. Reads
      // cannot recover, create, or replace a missing/stopped resource.
      if (scope.providerWorkspaceId) {
        const existing = await provider.inspect(scope.providerWorkspaceId, currentSignal);
        assertLifecycleResourceIdentity(existing, scope.providerWorkspaceId);
        if (scope.action === "start") assertLifecycleResourceIsolation(existing, scope.providerWorkspaceId);
      }
      // Validate the entire approved source graph before any creation side
      // effect. Unsupported repositories cannot leave an unused sandbox.
      if (scope.action === "clone") await repositoryTransport!.prepare(scope, () => validate(currentSignal), currentSignal);
      await validate(currentSignal);
      await store.markLifecycleDispatched(await owner(session, currentSignal), operation.id);
      dispatched = true;
      const beforeDispatch = () => validate(currentSignal);
      if (scope.action === "create" || scope.action === "clone") {
        const identity = { operationId: operation.id, projectId: scope.projectId, workspaceRecordId: scope.workspaceRecordId };
        const created = await provider.create(identity, currentSignal, beforeDispatch);
        assertNewLifecycleResource(created, identity);
        // Persist the exact verified provider ID before repository transfer.
        // A later failure retains this original binding for reconciliation.
        await store.recordLifecycleResource(await owner(session, currentSignal), operation.id, created.id);
        if (scope.action === "clone") {
          await validate(currentSignal);
          const initialized = await repositoryTransport!.initialize(scope, operation.id, created.id, beforeDispatch, currentSignal);
          evidence(scope, operation.id, created, initialized);
          await validate(currentSignal);
          const completed = await provider.inspect(created.id, currentSignal);
          assertLifecycleResourceIdentity(completed, created.id);
          assertNewLifecycleResource(completed, identity);
          // Read-only independent verification, not the mutation receipt, is
          // the final authority for Git registration.
          const inspected = await repositoryTransport!.inspect(scope, operation.id, created.id, beforeDispatch, currentSignal);
          await validate(currentSignal);
          return { resource: completed, initialized: inspected };
        }
        return { resource: created, initialized: undefined };
      }
      return { resource: await (scope.action === "start" ? provider.start(scope.providerWorkspaceId!, currentSignal, beforeDispatch) : provider.stop(scope.providerWorkspaceId!, currentSignal, beforeDispatch)), initialized: undefined };
    });
    const { resource, initialized } = result;
    await owner(session, signal);
    if (scope.action === "create" || scope.action === "clone") {
      assertNewLifecycleResource(resource, { operationId: operation.id, projectId: scope.projectId, workspaceRecordId: scope.workspaceRecordId });
    } else assertLifecycleResourceIdentity(resource, scope.providerWorkspaceId!);
    const verifiedEvidence = evidence(scope, operation.id, resource, initialized);
    await store.recordLifecycleResource(await owner(session, signal), operation.id, resource.id);
    await store.completeLifecycleOperation(await owner(session, signal), operation.id, verifiedEvidence);
    return operationView(await store.readLifecycleOperation(await owner(session, signal), operation.id));
  } catch (error) {
    // If this write fails, DISPATCHED itself retains the slot for reconciliation.
    try { await store.failLifecycleOperation(operation.id, dispatched); } catch { /* Fail closed; never retry provider work. */ }
    if (error instanceof ExecutionAuthorizationError) throw error;
    throw new ExecutionAuthorizationError(503, "Workspace lifecycle outcome could not be verified.");
  }
}

/** Read-only provider reconciliation can confirm the original reservation; it
 * cannot replace a workspace, repeat creation, start/stop, clone or delete. */
export async function reconcileWorkspaceLifecycleWithProvider(session: AuthSession, id: string, provider: LifecycleProvider,
  signal?: AbortSignal, repositoryTransport?: RepositoryInitializationTransport) {
  const binding = await owner(session, signal);
  const operation = await store.readLifecycleOperation(binding, id);
  if (!operation) throw new ExecutionAuthorizationError(404);
  if (operation.status === "SUCCEEDED") return operationView(operation);
  if (operation.status === "RESERVED") {
    return operationView(await store.cancelReservedLifecycleOperation(binding, id));
  }
  const scope = validateWorkspaceLifecycleScope(operation.scope);
  if (scope.action === "clone" && !repositoryTransport) assertPrivateRepositoryCloningAvailable();
  if (!["UNKNOWN", "DISPATCHED"].includes(operation.status)) throw new ExecutionAuthorizationError(409);
  await store.claimLifecycleReconciliation(binding, id);
  try {
    const validate = async (currentSignal: AbortSignal) => {
      const current = await store.readLifecycleOperation(await owner(session, currentSignal), id);
      if (!current || current.scopeDigest !== operation.scopeDigest ||
          (operation.providerResourceId && current.providerResourceId !== operation.providerResourceId)) throw new ExecutionAuthorizationError(409);
    };
    const result = await authorizedWait(session, signal, validate, async (currentSignal) => {
      let resource: LifecycleResource;
      if (scope.providerWorkspaceId || operation.providerResourceId) {
        const expectedId = scope.providerWorkspaceId ?? operation.providerResourceId!;
        resource = await provider.inspect(expectedId, currentSignal);
        assertLifecycleResourceIdentity(resource, expectedId);
        if (scope.action === "start") assertLifecycleResourceIsolation(resource, expectedId);
        if (scope.action === "create" || scope.action === "clone") assertNewLifecycleResource(resource, {
          operationId: operation.id, projectId: scope.projectId, workspaceRecordId: scope.workspaceRecordId });
      } else {
        const identity = { operationId: operation.id, projectId: scope.projectId, workspaceRecordId: scope.workspaceRecordId };
        const matches = await provider.findCreated(identity, currentSignal);
        if (matches.length !== 1) throw new ExecutionAuthorizationError(409, "Workspace reconciliation requires verified provider evidence.");
        assertNewLifecycleResource(matches[0], identity);
        resource = matches[0];
      }
      if (scope.action !== "clone") return { resource, initialized: undefined };
      await validate(currentSignal);
      await store.recordLifecycleResource(await owner(session, currentSignal), id, resource.id);
      const initialized = await repositoryTransport!.inspect(scope, id, resource.id, () => validate(currentSignal), currentSignal);
      await validate(currentSignal);
      return { resource, initialized };
    });
    if (scope.action === "clone" && result.initialized && ["absent", "incomplete", "mismatched"].includes(result.initialized.status)) {
      // Safe, bounded diagnostic only. Never retry initialization or release
      // the reservation when read-only verification finds incomplete effects.
      return { ...operationView(await store.readLifecycleOperation(await owner(session, signal), id)),
        repositoryState: result.initialized.status };
    }
    await store.reconcileLifecycleOperation(await owner(session, signal), operation.id, evidence(scope, operation.id, result.resource, result.initialized));
    return operationView(await store.readLifecycleOperation(await owner(session, signal), operation.id));
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) throw error;
    throw new ExecutionAuthorizationError(503, "Workspace reconciliation could not be verified.");
  }
}

export async function inspectWorkspaceLifecycleWithProvider(session: AuthSession, projectId: string, provider: LifecycleProvider, signal?: AbortSignal) {
  await owner(session, signal);
  const scope = await registeredScope(session, projectId, "start", signal);
  try {
    const resource = await authorizedWait(session, signal, async (currentSignal) => {
      const current = await registeredScope(session, projectId, "start", currentSignal);
      if (workspaceLifecycleScopeDigest(current) !== workspaceLifecycleScopeDigest(scope)) throw new ExecutionAuthorizationError(409);
    }, currentSignal => provider.inspect(scope.providerWorkspaceId!, currentSignal));
    assertLifecycleResourceIdentity(resource, scope.providerWorkspaceId!);
    const current = await registeredScope(session, projectId, "start", signal);
    if (workspaceLifecycleScopeDigest(current) !== workspaceLifecycleScopeDigest(scope)) throw new ExecutionAuthorizationError(409);
    return { ok: true, projectId, workspaceId: scope.workspaceRecordId, state: resource.state };
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) throw error;
    throw new ExecutionAuthorizationError(503, "The registered workspace is unavailable.");
  }
}

function configuredProvider() {
  return createPrivateLifecycleProvider({ apiKey: process.env.DAYTONA_API_KEY ?? "", apiUrl: process.env.DAYTONA_API_URL,
    snapshot: process.env.CR8OR_PRIVATE_DAYTONA_SNAPSHOT ?? "" });
}
async function configuredRepositoryTransport(): Promise<RepositoryInitializationTransport> {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new ExecutionAuthorizationError(503);
  const [{ DaytonaProvider }, { createPrivateRepositoryInitializationTransport }] = await Promise.all([
    import("@/lib/workspace/providers/daytona"), import("@/lib/workspace/private-repository-initialization"),
  ]);
  return createPrivateRepositoryInitializationTransport(new DaytonaProvider({ apiKey, apiUrl: process.env.DAYTONA_API_URL }),
    // Future release requires independent repository-scoped read-only permission
    // verification. The variable name alone is no proof of least privilege.
    () => process.env.CR8OR_PRIVATE_GITHUB_CLONE_TOKEN);
}
export async function executeWorkspaceLifecycle(session: AuthSession, input: unknown, approvalId?: string, signal?: AbortSignal) {
  await owner(session, signal);
  assertWorkspaceLifecycleAvailable();
  let transport: RepositoryInitializationTransport | undefined;
  if (parseWorkspaceLifecycleRequest(input).action === "clone") {
    assertPrivateRepositoryCloningAvailable();
    transport = await configuredRepositoryTransport();
  }
  return executeWorkspaceLifecycleWithProvider(session, input, configuredProvider(), approvalId, signal, transport);
}
export async function reconcileWorkspaceLifecycle(session: AuthSession, id: string, signal?: AbortSignal) {
  await owner(session, signal);
  assertWorkspaceLifecycleAvailable();
  const operation = await store.readLifecycleOperation(await owner(session, signal), id);
  let transport: RepositoryInitializationTransport | undefined;
  if (operation?.action === "clone") {
    assertPrivateRepositoryCloningAvailable();
    transport = await configuredRepositoryTransport();
  }
  return reconcileWorkspaceLifecycleWithProvider(session, id, configuredProvider(), signal, transport);
}
export async function inspectWorkspaceLifecycle(session: AuthSession, projectId: string, signal?: AbortSignal) {
  await owner(session, signal);
  assertWorkspaceLifecycleAvailable();
  return inspectWorkspaceLifecycleWithProvider(session, projectId, configuredProvider(), signal);
}
