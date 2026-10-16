import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ construct: vi.fn(), get: vi.fn(), create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@daytona/sdk", () => ({ Daytona: class {
  get = mocks.get; create = mocks.create;
  constructor(config: unknown) { mocks.construct(config); }
} }));
import { DaytonaProvider } from "@/lib/workspace/providers/daytona";
import { assertPrivateCloudCommandAvailable } from "@/lib/workspace/private-cloud-command-availability";
const configuration = { apiKey: "synthetic-provider-key", apiUrl: "https://daytona.invalid" };
const admitted = () => ({ id: "registered", state: "started", user: "daytona", public: false,
  networkBlockAll: true, env: {}, volumes: [], cpu: 2, gpu: 0, memory: 4, disk: 10,
  process: { marker: "isolated-adapter" } });
beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue(admitted()); });
describe("private command provider admission", () => {
  it("uses exact existing sandbox and bounded client without creating or reconfiguring", async () => {
    const provider = new DaytonaProvider(configuration);
    await expect(provider.getPrivateCommandSessionProcess("registered")).resolves.toEqual({ marker: "isolated-adapter" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("registered");
    expect(mocks.construct).toHaveBeenLastCalledWith({ ...configuration, requestTimeoutMs: 5000, useDeprecatedPolling: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    { id: "another" }, { state: "stopped" }, { user: "root" }, { user: "0" }, { public: true },
    { networkBlockAll: false }, { networkBlockAll: undefined }, { networkAllowList: "0.0.0.0/0" },
    { domainAllowList: "example.com" }, { outboundProxyUrl: "https://proxy.invalid" }, { linkedSandboxId: "another" },
    { volumes: undefined }, { volumes: [{ mountPath: "/credentials" }] }, { env: undefined },
    { env: { DATABASE_URL: "synthetic-secret" } }, { env: [] }, { cpu: 0 }, { cpu: 3 }, { cpu: NaN },
    { memory: 0 }, { memory: 5 }, { disk: 0 }, { disk: 11 }, { gpu: 1 },
  ])("rejects missing or unsuitable isolation metadata %j", async (change) => {
    mocks.get.mockResolvedValue({ ...admitted(), ...change });
    await expect(new DaytonaProvider(configuration).getPrivateCommandSessionProcess("registered"))
      .rejects.toMatchObject({ status: 503, message: "The registered command environment is unavailable." });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["", "   ", "x".repeat(257), "é".repeat(129), "bad\0id", null, undefined])("rejects invalid identifiers before lookup %s", async (id) => {
    await expect(new DaytonaProvider(configuration).getPrivateCommandSessionProcess(id as string)).rejects.toMatchObject({ status: 503 });
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("reads metadata anew instead of caching isolation decisions", async () => {
    const provider = new DaytonaProvider(configuration);
    await provider.getPrivateCommandSessionProcess("registered");
    mocks.get.mockResolvedValue({ ...admitted(), user: "root" });
    await expect(provider.getPrivateCommandSessionProcess("registered")).rejects.toMatchObject({ status: 503 });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it("sanitizes provider errors without a sensitive cause", async () => {
    mocks.get.mockRejectedValue(new Error("synthetic-provider-secret"));
    const error = await new DaytonaProvider(configuration).getPrivateCommandSessionProcess("registered").catch((e) => e);
    expect(error.status).toBe(503); expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain("synthetic-provider-secret");
  });
  it("keeps the release restriction closed independently of feature or environment flags", () => {
    for (const value of ["true", "false", "1", "invalid", undefined]) {
      vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", value);
      vi.stubEnv("CR8OR_PRIVATE_COMMANDS_ENABLED", "true");
      expect(assertPrivateCloudCommandAvailable).toThrow(/await isolated provider/);
    }
    vi.unstubAllEnvs();
  });
});
