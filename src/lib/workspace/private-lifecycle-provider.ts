import "server-only";

import { Daytona, type Sandbox } from "@daytona/sdk";

export const LIFECYCLE_PROVIDER_LIMITS = Object.freeze({ requestMs: 5_000, operationMs: 30_000, reconciliationMatches: 2 });
const states = new Set(["creating", "restoring", "destroyed", "destroying", "started", "stopped", "starting", "stopping",
  "error", "build_failed", "pending_build", "building_snapshot", "unknown", "pulling_snapshot", "archived", "archiving",
  "resizing", "snapshotting", "forking", "pausing", "paused", "resuming"]);
export type LifecycleResourceState = "started" | "stopped" | "creating" | "restoring" | "destroyed" | "destroying" |
  "starting" | "stopping" | "error" | "build_failed" | "pending_build" | "building_snapshot" | "unknown" |
  "pulling_snapshot" | "archived" | "archiving" | "resizing" | "snapshotting" | "forking" | "pausing" | "paused" | "resuming";
export type LifecycleCreationIdentity = Readonly<{ operationId: string; projectId: string; workspaceRecordId: string }>;
export type LifecycleResource = Readonly<{
  id: string; state: LifecycleResourceState; labels: Readonly<Record<string, string>>;
  // Necessary metadata checks, not attestation of snapshot contents or provider isolation.
  isolationVerified: boolean;
}>;
export interface LifecycleProvider {
  create(input: LifecycleCreationIdentity, signal: AbortSignal, beforeDispatch?: () => Promise<void>): Promise<LifecycleResource>;
  inspect(id: string, signal: AbortSignal): Promise<LifecycleResource>;
  start(id: string, signal: AbortSignal, beforeDispatch?: () => Promise<void>): Promise<LifecycleResource>;
  stop(id: string, signal: AbortSignal, beforeDispatch?: () => Promise<void>): Promise<LifecycleResource>;
  findCreated(input: LifecycleCreationIdentity, signal: AbortSignal): Promise<LifecycleResource[]>;
}
type ErrorCode = "UNAVAILABLE" | "INVALID_RESOURCE" | "TIMED_OUT" | "CANCELLED" | "CLONE_UNAVAILABLE";
export class LifecycleProviderError extends Error {
  readonly status = 503;
  constructor(readonly code: ErrorCode, readonly uncertain = false) {
    super(code === "CLONE_UNAVAILABLE" ? "Private repository cloning awaits verified credential delivery."
      : code === "CANCELLED" ? "The workspace operation was interrupted."
      : "The workspace operation could not be verified.");
    this.name = "LifecycleProviderError";
  }
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
const labelKeys = ["cr8or-lifecycle", "cr8or-owner", "cr8or-operation", "cr8or-project", "cr8or-registration"] as const;
export function lifecycleCreationLabels(input: LifecycleCreationIdentity): Readonly<Record<string, string>> {
  if (!input || !identifier(input.operationId) || !identifier(input.projectId) || !identifier(input.workspaceRecordId)) {
    throw new LifecycleProviderError("INVALID_RESOURCE");
  }
  return Object.freeze({ "cr8or-lifecycle": "1", "cr8or-owner": "owner", "cr8or-operation": input.operationId,
    "cr8or-project": input.projectId, "cr8or-registration": input.workspaceRecordId });
}
export function assertLifecycleResourceIdentity(resource: LifecycleResource, id: string): void {
  if (!identifier(id) || !resource || resource.id !== id || !states.has(resource.state)) {
    throw new LifecycleProviderError("INVALID_RESOURCE");
  }
}
export function assertNewLifecycleResource(resource: LifecycleResource, input: LifecycleCreationIdentity, id?: string): void {
  assertLifecycleResourceIdentity(resource, id ?? resource?.id);
  const expected = lifecycleCreationLabels(input);
  if (resource.isolationVerified !== true || !resource.labels ||
      Object.entries(expected).some(([key, value]) => resource.labels[key] !== value)) {
    throw new LifecycleProviderError("INVALID_RESOURCE");
  }
}

/** The installed Git.clone(url,path,branch,commit,username,password,...) sends
 * credentials in a toolbox JSON request. It offers no scoped-token lifecycle,
 * non-persistence guarantee, or contained root creation. Do not pass broad
 * server tokens, mount secrets, use shell commands, or fall back to uploads. */
export function assertPrivateRepositoryCloneAvailable(): never {
  throw new LifecycleProviderError("CLONE_UNAVAILABLE");
}

type ProviderConfig = Readonly<{ apiKey: string; apiUrl?: string; target?: string; snapshot: string }>;
/** Call only from the server-owned lifecycle service after its release gate,
 * durable reservation and session checks. The adapter establishes transport
 * facts; it never establishes owner authorization from labels or a name. */
export function createPrivateLifecycleProvider(config: ProviderConfig): LifecycleProvider {
  const apiUrl = config?.apiUrl ?? "https://app.daytona.io/api";
  const target = config?.target ?? "us";
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || apiUrl.length > 512 ||
        !config || typeof config.apiKey !== "string" || !config.apiKey || config.apiKey.length > 4096 ||
        !identifier(config.snapshot) || !identifier(target)) throw new Error();
  } catch { throw new LifecycleProviderError("UNAVAILABLE"); }
  const snapshot = config.snapshot;
  let client: Daytona;
  try {
    client = new Daytona({ apiKey: config.apiKey, apiUrl, target,
      requestTimeoutMs: LIFECYCLE_PROVIDER_LIMITS.requestMs, useDeprecatedPolling: true, otelEnabled: false });
  } catch { throw new LifecycleProviderError("UNAVAILABLE"); }

  function resource(sandbox: Sandbox): LifecycleResource {
    if (!sandbox || !identifier(sandbox.id) || !states.has(String(sandbox.state)) ||
        !sandbox.labels || typeof sandbox.labels !== "object" || Array.isArray(sandbox.labels) ||
        Object.keys(sandbox.labels).length > 32 || Object.entries(sandbox.labels).some(([key, value]) =>
          key.length > 128 || typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256)) {
      throw new LifecycleProviderError("INVALID_RESOURCE");
    }
    const labels: Record<string, string> = {};
    for (const key of labelKeys) {
      if (Object.hasOwn(sandbox.labels, key)) {
        if (!identifier(sandbox.labels[key])) throw new LifecycleProviderError("INVALID_RESOURCE");
        labels[key] = sandbox.labels[key];
      }
    }
    const empty = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
    const bounded = (value: number, maximum: number) => Number.isFinite(value) && value > 0 && value <= maximum;
    const isolationVerified = sandbox.snapshot === snapshot && sandbox.target === target && sandbox.user === "daytona" &&
      sandbox.public === false && sandbox.networkBlockAll === true && !sandbox.networkAllowList && !sandbox.domainAllowList &&
      !sandbox.outboundProxyUrl && !sandbox.linkedSandboxId && !sandbox.otelEndpointOverride && !sandbox.warmPoolId &&
      Array.isArray(sandbox.volumes) && sandbox.volumes.length === 0 && empty(sandbox.env) &&
      sandbox.gpu === 0 && bounded(sandbox.cpu, 2) && bounded(sandbox.memory, 4) && bounded(sandbox.disk, 10) &&
      sandbox.autoStopInterval === 15 && sandbox.autoPauseInterval === 0 && sandbox.autoDeleteInterval === -1 && !sandbox.autoDestroyAt;
    return Object.freeze({ id: sandbox.id, state: sandbox.state as LifecycleResourceState,
      labels: Object.freeze(labels), isolationVerified });
  }

  // SDK lifecycle methods have no AbortSignal. The deadline bounds our wait and
  // suppresses further dispatch after cancellation; it cannot undo remote work.
  // Mutating calls that throw (including verification failures) stay uncertain.
  async function operation<T>(signal: AbortSignal, run: (step: <R>(mutates: boolean, fn: (seconds: number) => Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
    let dispatched = false;
    let finished = false;
    const deadline = performance.now() + LIFECYCLE_PROVIDER_LIMITS.operationMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const check = () => {
      if (signal.aborted || finished) throw new LifecycleProviderError("CANCELLED", dispatched);
      if (performance.now() >= deadline) throw new LifecycleProviderError("TIMED_OUT", dispatched);
    };
    try {
      check();
      return await Promise.race([run(async (mutates, fn) => {
        check();
        if (mutates) dispatched = true;
        const result = await fn(Math.max(0.001, (deadline - performance.now()) / 1000));
        check();
        return result;
      }), new Promise<never>((_, reject) => {
        abort = () => reject(new LifecycleProviderError("CANCELLED", dispatched));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new LifecycleProviderError("TIMED_OUT", dispatched)), LIFECYCLE_PROVIDER_LIMITS.operationMs);
        if (signal.aborted) abort();
      })]);
    } catch (error) {
      throw new LifecycleProviderError(error instanceof LifecycleProviderError ? error.code : "UNAVAILABLE", dispatched);
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  async function existing(id: string, signal: AbortSignal, action?: "start" | "stop", beforeDispatch?: () => Promise<void>): Promise<LifecycleResource> {
    if (!identifier(id)) throw new LifecycleProviderError("INVALID_RESOURCE");
    return operation(signal, async (step) => {
      const sandbox = await step(false, () => client.get(id));
      const before = resource(sandbox);
      assertLifecycleResourceIdentity(before, id); // SDK get accepts names too; never authorize an alias.
      if (!action) return before; // Inspection never starts, recreates, recovers or changes labels.
      const desired = action === "start" ? "started" : "stopped";
      if (before.state === desired) return before;
      if (before.state !== (action === "start" ? "stopped" : "started")) throw new LifecycleProviderError("INVALID_RESOURCE");
      // A historical auto-delete policy could destroy data on stop. Do not
      // alter it here; require separate operator remediation before transition.
      if (sandbox.autoDeleteInterval !== -1 || sandbox.autoDestroyAt) throw new LifecycleProviderError("INVALID_RESOURCE");
      if (beforeDispatch) await step(false, beforeDispatch);
      await step(true, (seconds) => action === "start" ? sandbox.start(seconds) : sandbox.stop(seconds, false));
      const after = resource(await step(false, () => client.get(id)));
      assertLifecycleResourceIdentity(after, id);
      if (after.state !== desired) throw new LifecycleProviderError("INVALID_RESOURCE");
      return after;
    });
  }
  return Object.freeze({
    async create(input: LifecycleCreationIdentity, signal: AbortSignal, beforeDispatch?: () => Promise<void>) {
      const labels = lifecycleCreationLabels(input);
      const identity = Object.freeze({ ...input });
      return operation(signal, async (step) => {
        if (beforeDispatch) await step(false, beforeDispatch);
        const created = await step(true, (seconds) => client.create({ snapshot, user: "daytona", public: false,
          envVars: {}, secrets: {}, volumes: [], labels: { ...labels }, networkBlockAll: true,
          autoStopInterval: 15, autoPauseInterval: 0, autoDeleteInterval: -1, ttlMinutes: 0, ephemeral: false }, { timeout: seconds }));
        const initial = resource(created);
        assertNewLifecycleResource(initial, identity);
        const verified = resource(await step(false, () => client.get(initial.id)));
        assertNewLifecycleResource(verified, identity, initial.id);
        if (verified.state !== "started") throw new LifecycleProviderError("INVALID_RESOURCE");
        return verified;
      });
    },
    inspect: (id: string, signal: AbortSignal) => existing(id, signal),
    start: (id: string, signal: AbortSignal, beforeDispatch?: () => Promise<void>) => existing(id, signal, "start", beforeDispatch),
    stop: (id: string, signal: AbortSignal, beforeDispatch?: () => Promise<void>) => existing(id, signal, "stop", beforeDispatch),
    async findCreated(input: LifecycleCreationIdentity, signal: AbortSignal) {
      const labels = lifecycleCreationLabels(input);
      const identity = Object.freeze({ ...input });
      return operation(signal, async (step) => {
        const iterator = client.list({ labels: { ...labels }, limit: LIFECYCLE_PROVIDER_LIMITS.reconciliationMatches + 1 });
        const found: LifecycleResource[] = [];
        const seen = new Set<string>();
        try {
          for (;;) {
            const item = await step(false, () => iterator.next());
            if (item.done) return found;
            if (found.length >= LIFECYCLE_PROVIDER_LIMITS.reconciliationMatches || !identifier(item.value.id) || seen.has(item.value.id)) {
              throw new LifecycleProviderError("INVALID_RESOURCE");
            }
            seen.add(item.value.id);
            // list omits security metadata; fresh exact-ID get is mandatory.
            const verified = resource(await step(false, () => client.get(item.value.id)));
            assertNewLifecycleResource(verified, identity, item.value.id);
            found.push(verified);
          }
        } finally {
          // Return ends pagination only. It does not cancel a provider operation.
          void iterator.return?.().catch(() => undefined);
        }
      });
    },
  });
}
