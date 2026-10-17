import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ construct: vi.fn(), create: vi.fn(), get: vi.fn(), list: vi.fn() }));
vi.mock("@daytona/sdk", () => ({ Daytona: class {
  create = mocks.create; get = mocks.get; list = mocks.list;
  constructor(config: unknown) { mocks.construct(config); }
} }));
import { assertLifecycleResourceIdentity, assertNewLifecycleResource, assertPrivateRepositoryCloneAvailable,
  createPrivateLifecycleProvider, lifecycleCreationLabels, LIFECYCLE_PROVIDER_LIMITS,
  type LifecycleResource } from "@/lib/workspace/private-lifecycle-provider";

// Controlled SDK doubles exercise the actual adapter and no live resources.
// They cannot establish provider-side snapshot/credential/isolation guarantees.
const config = { apiKey: "synthetic-provider-key", apiUrl: "https://daytona.invalid/api", snapshot: "reviewed-snapshot" };
const identity = { operationId: "operation-one", projectId: "project-one", workspaceRecordId: "registration-one" };
const signal = () => new AbortController().signal;
function sandbox(patch: Record<string, unknown> = {}) {
  return { id: "sandbox-one", state: "started", labels: { ...lifecycleCreationLabels(identity), "code-toolbox-language": "python" },
    snapshot: config.snapshot, target: "us", user: "daytona", public: false, networkBlockAll: true,
    env: {}, volumes: [], cpu: 2, memory: 4, disk: 10, gpu: 0, autoDeleteInterval: -1, autoStopInterval: 15, autoPauseInterval: 0,
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), delete: vi.fn(), recover: vi.fn(),
    git: { clone: vi.fn() }, fs: { createFolder: vi.fn() }, process: { executeCommand: vi.fn() }, ...patch };
}
async function* listed(items: unknown[]) { yield* items; }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue(sandbox());
  mocks.get.mockResolvedValue(sandbox());
  mocks.list.mockImplementation(() => listed([]));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("bounded private Daytona lifecycle adapter", () => {
  it("creates only the server reservation with no credentials or mounts and verifies the returned exact ID anew", async () => {
    vi.stubEnv("GITHUB_TOKEN", "synthetic-github-secret");
    vi.stubEnv("DATABASE_URL", "synthetic-database-secret");
    vi.stubEnv("DAYTONA_TARGET", "unreviewed-target");
    const result = await createPrivateLifecycleProvider(config).create(identity, signal());
    expect(mocks.construct).toHaveBeenCalledExactlyOnceWith({ apiKey: config.apiKey, apiUrl: config.apiUrl, target: "us",
      requestTimeoutMs: 5000, useDeprecatedPolling: true, otelEnabled: false });
    const [input, options] = mocks.create.mock.calls[0];
    expect(input).toEqual({ snapshot: config.snapshot, user: "daytona", public: false, envVars: {}, secrets: {}, volumes: [],
      labels: lifecycleCreationLabels(identity), networkBlockAll: true, autoStopInterval: 15, autoPauseInterval: 0,
      autoDeleteInterval: -1, ttlMinutes: 0, ephemeral: false });
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(30);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("sandbox-one");
    expect(result).toEqual({ id: "sandbox-one", state: "started", labels: lifecycleCreationLabels(identity), isolationVerified: true });
    expect(JSON.stringify(input)).not.toMatch(/synthetic|TOKEN|DATABASE|password|clone|command/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.labels)).toBe(true);
  });

  it.each([
    { snapshot: "different" }, { target: "another-target" }, { user: "root" }, { public: true },
    { networkBlockAll: false }, { networkBlockAll: undefined }, { networkAllowList: "0.0.0.0/0" },
    { domainAllowList: "github.com" }, { outboundProxyUrl: "https://proxy.invalid" },
    { linkedSandboxId: "other-sandbox" }, { otelEndpointOverride: "https://log.invalid" }, { warmPoolId: "pool-one" },
    { env: undefined }, { env: { GITHUB_TOKEN: "synthetic-secret" } }, { env: [] },
    { volumes: undefined }, { volumes: [{ volumeId: "shared", mountPath: "/credentials" }] },
    { cpu: 0 }, { cpu: 3 }, { cpu: NaN }, { memory: 5 }, { disk: 11 }, { gpu: 1 },
    { autoStopInterval: 0 }, { autoPauseInterval: undefined }, { autoDeleteInterval: 0 },
    { autoDeleteInterval: undefined }, { autoDestroyAt: "2030-01-01T00:00:00Z" },
    { labels: {} }, { labels: { ...lifecycleCreationLabels(identity), "cr8or-project": "another-project" } },
    { labels: { ...lifecycleCreationLabels(identity), "cr8or-owner": "client-owner" } },
  ])("rejects unsafe new-resource metadata without deleting or retrying: %j", async (patch) => {
    const created = sandbox(patch);
    mocks.create.mockResolvedValue(created);
    await expect(createPrivateLifecycleProvider(config).create(identity, signal())).rejects.toMatchObject({ status: 503, uncertain: true });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(created.delete).not.toHaveBeenCalled();
    expect(created.recover).not.toHaveBeenCalled();
  });

  it.each([{ id: "wrong-resource" }, { state: "stopped" }, { labels: {} }, { networkBlockAll: false }])(
    "does not register creation when the independent exact-ID read fails verification %j", async (patch) => {
      mocks.get.mockResolvedValue(sandbox(patch));
      await expect(createPrivateLifecycleProvider(config).create(identity, signal())).rejects.toMatchObject({ uncertain: true });
      expect(mocks.create).toHaveBeenCalledTimes(1);
    });

  it("does not expose historical environment values, provider URLs or arbitrary labels during inspection", async () => {
    const historical = sandbox({ state: "stopped", labels: { "private-value": "synthetic-label-secret" },
      env: { GITHUB_TOKEN: "synthetic-environment-secret" }, toolboxProxyUrl: "https://secret.invalid", errorReason: "synthetic-provider-secret" });
    mocks.get.mockResolvedValue(historical);
    await expect(createPrivateLifecycleProvider(config).inspect("sandbox-one", signal())).resolves.toEqual({
      id: "sandbox-one", state: "stopped", labels: {}, isolationVerified: false,
    });
    expect(historical.start).not.toHaveBeenCalled();
    expect(historical.recover).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["", "../sandbox", "https://sandbox.invalid", "x".repeat(129), "bad\0id", "sandbox with spaces"])(
    "rejects malformed identifiers before provider lookup: %s", async (id) => {
      await expect(createPrivateLifecycleProvider(config).inspect(id, signal())).rejects.toMatchObject({ code: "INVALID_RESOURCE", uncertain: false });
      expect(mocks.get).not.toHaveBeenCalled();
    });
  it("rejects provider-name lookup resolving a different actual ID", async () => {
    await expect(createPrivateLifecycleProvider(config).inspect("sandbox-name", signal())).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([{ state: undefined }, { state: "made-up-state" }, { labels: [] }, { labels: { key: "x".repeat(257) } }])(
    "rejects malformed or oversized response metadata %j", async (patch) => {
      mocks.get.mockResolvedValue(sandbox(patch));
      await expect(createPrivateLifecycleProvider(config).inspect("sandbox-one", signal())).rejects.toMatchObject({ status: 503 });
    });

  it.each(["start", "stop"] as const)("performs explicit %s without replacement and verifies state using exact-ID retrieval", async (action) => {
    const initial = sandbox({ state: action === "start" ? "stopped" : "started", labels: {} });
    mocks.get.mockResolvedValueOnce(initial).mockResolvedValueOnce(sandbox({ state: action === "start" ? "started" : "stopped" }));
    const result = await createPrivateLifecycleProvider(config)[action]("sandbox-one", signal());
    expect(initial[action]).toHaveBeenCalledTimes(1);
    const [seconds, force] = initial[action].mock.calls[0] as unknown as [number, boolean?];
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(30);
    if (action === "stop") expect(force).toBe(false);
    expect(result.state).toBe(action === "start" ? "started" : "stopped");
    expect(mocks.get.mock.calls).toEqual([["sandbox-one"], ["sandbox-one"]]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(initial.delete).not.toHaveBeenCalled();
    expect(initial.recover).not.toHaveBeenCalled();
  });
  it.each(["start", "stop"] as const)("treats already completed %s as a non-mutating exact-state observation", async (action) => {
    const initial = sandbox({ state: action === "start" ? "started" : "stopped" });
    mocks.get.mockResolvedValue(initial);
    await createPrivateLifecycleProvider(config)[action]("sandbox-one", signal());
    expect(initial[action]).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it.each(["error", "archived", "starting", "destroyed"])("never recovers, starts or replaces unknown transitional state %s", async (state) => {
    const initial = sandbox({ state });
    mocks.get.mockResolvedValue(initial);
    await expect(createPrivateLifecycleProvider(config).start("sandbox-one", signal())).rejects.toMatchObject({ uncertain: false });
    expect(initial.start).not.toHaveBeenCalled();
    expect(initial.recover).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([{ autoDeleteInterval: 0 }, { autoDeleteInterval: undefined }, { autoDeleteInterval: 10 }, { autoDestroyAt: "2030-01-01" }])(
    "preserves historical resources with unsafe or unknown destruction policies %j", async (patch) => {
      const initial = sandbox(patch);
      mocks.get.mockResolvedValue(initial);
      await expect(createPrivateLifecycleProvider(config).stop("sandbox-one", signal())).rejects.toMatchObject({ uncertain: false });
      expect(initial.stop).not.toHaveBeenCalled();
      expect(initial.delete).not.toHaveBeenCalled();
    });
  it("marks unconfirmed post-stop state uncertain without destructive recovery", async () => {
    const initial = sandbox();
    mocks.get.mockResolvedValue(initial);
    await expect(createPrivateLifecycleProvider(config).stop("sandbox-one", signal())).rejects.toMatchObject({ uncertain: true });
    expect(initial.stop).toHaveBeenCalledTimes(1);
    expect(initial.delete).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("reconciles only exact reservation labels and refreshes incomplete list metadata", async () => {
    mocks.list.mockImplementation(() => listed([{ id: "sandbox-one" }]));
    const found = await createPrivateLifecycleProvider(config).findCreated(identity, signal());
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ labels: lifecycleCreationLabels(identity), limit: 3 });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("sandbox-one");
    expect(found).toHaveLength(1);
    expect(found[0].isolationVerified).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns absence without creating or retrying an uncertain operation", async () => {
    await expect(createPrivateLifecycleProvider(config).findCreated(identity, signal())).resolves.toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("reports two matching resources for service-level ambiguity handling rather than choosing one", async () => {
    mocks.list.mockImplementation(() => listed([{ id: "sandbox-one" }, { id: "sandbox-two" }]));
    mocks.get.mockResolvedValueOnce(sandbox()).mockResolvedValueOnce(sandbox({ id: "sandbox-two" }));
    const resources = await createPrivateLifecycleProvider(config).findCreated(identity, signal());
    expect(resources.map(({ id }) => id)).toEqual(["sandbox-one", "sandbox-two"]);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([["sandbox-one", "sandbox-one"], ["sandbox-one", "sandbox-two", "sandbox-three"]])(
    "rejects duplicate or excessive reconciliation results %j", async (...ids) => {
      mocks.list.mockImplementation(() => listed(ids.map((id) => ({ id }))));
      mocks.get.mockImplementation(async (id: string) => sandbox({ id }));
      await expect(createPrivateLifecycleProvider(config).findCreated(identity, signal())).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
      expect(mocks.get.mock.calls.length).toBeLessThanOrEqual(2);
    });
  it("rejects a mislabeled list match rather than treating labels or names as ownership", async () => {
    mocks.list.mockImplementation(() => listed([{ id: "sandbox-one" }]));
    mocks.get.mockResolvedValue(sandbox({ labels: { ...lifecycleCreationLabels(identity), "cr8or-registration": "other-registration" } }));
    await expect(createPrivateLifecycleProvider(config).findCreated(identity, signal())).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });
  it("closes the listing iterator after rejected metadata without deleting a resource", async () => {
    const iterator = { next: vi.fn().mockResolvedValue({ done: false, value: { id: "bad/id" } }), return: vi.fn().mockResolvedValue({ done: true }) };
    mocks.list.mockReturnValue(iterator);
    await expect(createPrivateLifecycleProvider(config).findCreated(identity, signal())).rejects.toMatchObject({ status: 503 });
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("rejects cancellation before dispatch", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createPrivateLifecycleProvider(config).create(identity, controller.signal)).rejects.toMatchObject({ code: "CANCELLED", uncertain: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["create", "start", "stop"] as const)("revalidates immediately before %s and rejects revoked authorization without dispatch", async (action) => {
    const initial = sandbox({ state: action === "start" ? "stopped" : "started" });
    mocks.get.mockResolvedValue(initial);
    const check = vi.fn(async () => {
      if (action !== "create") expect(mocks.get).toHaveBeenCalledExactlyOnceWith("sandbox-one");
      throw new Error("Synthetic session was revoked.");
    });
    const provider = createPrivateLifecycleProvider(config);
    const result = action === "create" ? provider.create(identity, signal(), check) : provider[action]("sandbox-one", signal(), check);
    await expect(result).rejects.toMatchObject({ uncertain: false });
    expect(check).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(initial.start).not.toHaveBeenCalled();
    expect(initial.stop).not.toHaveBeenCalled();
  });
  it("checks cancellation again after the final authorization callback", async () => {
    const controller = new AbortController();
    await expect(createPrivateLifecycleProvider(config).create(identity, controller.signal, async () => { controller.abort(); }))
      .rejects.toMatchObject({ code: "CANCELLED", uncertain: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not schedule a late start after cancellation during lookup", async () => {
    let release!: (value: ReturnType<typeof sandbox>) => void;
    mocks.get.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const initial = sandbox({ state: "stopped" });
    const outcome = createPrivateLifecycleProvider(config).start("sandbox-one", controller.signal).catch((error: unknown) => error);
    controller.abort();
    expect(await outcome).toMatchObject({ code: "CANCELLED", uncertain: false });
    release(initial); await Promise.resolve(); await Promise.resolve();
    expect(initial.start).not.toHaveBeenCalled();
  });
  it("records cancellation after create as uncertain and never claims provider cancellation", async () => {
    let release!: (value: ReturnType<typeof sandbox>) => void;
    mocks.create.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const outcome = createPrivateLifecycleProvider(config).create(identity, controller.signal).catch((error: unknown) => error);
    controller.abort();
    expect(await outcome).toMatchObject({ code: "CANCELLED", uncertain: true });
    const created = sandbox(); release(created); await Promise.resolve(); await Promise.resolve();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(created.delete).not.toHaveBeenCalled();
  });
  it.each(["create", "inspect"] as const)("bounds a hung %s and does not retry", async (action) => {
    vi.useFakeTimers();
    mocks.create.mockReturnValue(new Promise(() => undefined));
    mocks.get.mockReturnValue(new Promise(() => undefined));
    const provider = createPrivateLifecycleProvider(config);
    const outcome = (action === "create" ? provider.create(identity, signal()) : provider.inspect("sandbox-one", signal()))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(LIFECYCLE_PROVIDER_LIMITS.operationMs + 1);
    expect(await outcome).toMatchObject({ code: "TIMED_OUT", uncertain: action === "create" });
    expect(mocks.create).toHaveBeenCalledTimes(action === "create" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["create", "inspect"] as const)("sanitizes %s failures without secret-bearing causes or logs", async (action) => {
    const providerError = new Error("Authorization: synthetic-secret at https://private.invalid");
    mocks.create.mockRejectedValue(providerError); mocks.get.mockRejectedValue(providerError);
    const log = vi.spyOn(console, "error");
    const provider = createPrivateLifecycleProvider(config);
    const error = await (action === "create" ? provider.create(identity, signal()) : provider.inspect("sandbox-one", signal()))
      .catch((failure: Error) => failure);
    expect(error).toMatchObject({ code: "UNAVAILABLE", uncertain: action === "create" });
    expect(String(error)).not.toMatch(/synthetic|private.invalid|Authorization/);
    expect(error).not.toHaveProperty("cause");
    expect(log).not.toHaveBeenCalled(); log.mockRestore();
  });
  it.each([{ snapshot: "" }, { snapshot: "../../image" }, { apiKey: "" }, { apiUrl: "http://daytona.invalid" },
    { apiUrl: "https://user:password@daytona.invalid" }, { apiUrl: "https://daytona.invalid?token=secret" }, { target: "bad target" }])(
    "rejects unsafe trusted configuration without SDK construction %j", (patch) => {
      expect(() => createPrivateLifecycleProvider({ ...config, ...patch })).toThrow(/could not be verified/);
      expect(mocks.construct).not.toHaveBeenCalled();
    });
  it("sanitizes SDK constructor failures", () => {
    mocks.construct.mockImplementation(() => { throw new Error("synthetic-secret"); });
    expect(() => createPrivateLifecycleProvider(config)).toThrow("The workspace operation could not be verified.");
  });
  it("keeps private clone blocked without using Git, process, filesystem or secrets APIs", () => {
    expect(assertPrivateRepositoryCloneAvailable).toThrow(/awaits verified credential delivery/);
    expect(mocks.construct).not.toHaveBeenCalled();
  });
  it("requires the exact reservation fields for new registration while historical identity verification does not remap", () => {
    const resource: LifecycleResource = { id: "sandbox-one", state: "started", labels: lifecycleCreationLabels(identity), isolationVerified: true };
    expect(() => assertNewLifecycleResource(resource, identity, "sandbox-one")).not.toThrow();
    expect(() => assertNewLifecycleResource(resource, { ...identity, projectId: "another" })).toThrow();
    expect(() => assertNewLifecycleResource({ ...resource, isolationVerified: false }, identity)).toThrow();
    expect(() => assertLifecycleResourceIdentity(resource, "another")).toThrow();
  });
});
