import { lifecycleCreationLabels, LifecycleProviderError, type LifecycleProvider, type LifecycleResource } from "../../src/lib/workspace/private-lifecycle-provider";
import type { PrivateCloudSessionProcess } from "../../src/lib/workspace/private-cloud-write-session";
import { consumeOfflineOperation } from "./budget";

export const OFFLINE_CLONE_SANDBOX = "offline-pilot-clone";
export const OFFLINE_TIMEOUT_SANDBOX = "offline-pilot-timeout";

/** Controlled lifecycle shape, never a provider client. The true isolation bit
 * describes the synthetic fixture contract only, not runtime attestation. */
export function createOfflineLifecycleAdapter(process: PrivateCloudSessionProcess) {
  let resource: LifecycleResource | undefined;
  let operations = 0, creates = 0, inspections = 0, sessionBindings = 0;
  const attempt = () => { operations++; consumeOfflineOperation(); };
  const check = (id: string, signal?: AbortSignal) => {
    if (signal?.aborted || id !== OFFLINE_CLONE_SANDBOX || !resource) throw new Error("Offline workspace binding rejected.");
  };
  const provider: LifecycleProvider = {
    async create(identity, signal, beforeDispatch) {
      attempt();
      if (signal.aborted || resource) throw new Error("Offline duplicate creation rejected.");
      await beforeDispatch?.();
      if (signal.aborted) throw new Error("Offline creation cancelled.");
      creates++;
      resource = Object.freeze({ id: OFFLINE_CLONE_SANDBOX, state: "started", isolationVerified: true,
        labels: lifecycleCreationLabels(identity) });
      return resource;
    },
    async inspect(id, signal) { attempt(); check(id, signal); inspections++; return resource!; },
    async start() { attempt(); throw new Error("Lifecycle mutation is outside this offline fixture."); },
    async stop() { attempt(); throw new Error("Lifecycle mutation is outside this offline fixture."); },
    async findCreated(identity, signal) {
      attempt();
      check(OFFLINE_CLONE_SANDBOX, signal);
      const expected = lifecycleCreationLabels(identity);
      return Object.entries(expected).every(([key, value]) => resource!.labels[key] === value) ? [resource!] : [];
    },
  };
  return {
    provider,
    sessionProvider: {
      async getPrivateGitSessionProcess(id: string) {
        attempt();
        check(id); sessionBindings++; return process;
      },
    },
    evidence: () => ({ operations, creates, inspections, sessionBindings }),
  };
}

/** A single, named fault: the controlled resource is created, then the provider
 * timeout response is raised. No delay, live SDK call, retry or delete exists. */
export function createOfflineLifecycleTimeoutAdapter() {
  let resource: LifecycleResource | undefined;
  let operations = 0, creates = 0, inspections = 0;
  const attempt = () => { operations++; consumeOfflineOperation(); };
  const provider: LifecycleProvider = {
    async create(identity, signal, beforeDispatch) {
      attempt();
      if (signal.aborted || resource) throw new Error("Offline duplicate creation rejected.");
      await beforeDispatch?.();
      if (signal.aborted) throw new Error("Offline creation cancelled.");
      creates++;
      resource = Object.freeze({ id: OFFLINE_TIMEOUT_SANDBOX, state: "started", isolationVerified: true,
        labels: lifecycleCreationLabels(identity) });
      throw new LifecycleProviderError("TIMED_OUT", true);
    },
    async inspect(id, signal) {
      attempt();
      if (signal.aborted || !resource || id !== OFFLINE_TIMEOUT_SANDBOX) throw new Error("Offline workspace binding rejected.");
      inspections++; return resource;
    },
    async findCreated(identity, signal) {
      attempt();
      if (signal.aborted || !resource) throw new Error("Offline resource is unavailable.");
      const expected = lifecycleCreationLabels(identity);
      return Object.entries(expected).every(([key, value]) => resource!.labels[key] === value) ? [resource] : [];
    },
    async start() { attempt(); throw new Error("Lifecycle mutation is outside this offline fixture."); },
    async stop() { attempt(); throw new Error("Lifecycle mutation is outside this offline fixture."); },
  };
  return { provider, evidence: () => ({ operations, creates, inspections }) };
}
