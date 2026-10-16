import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  existingGet: vi.fn(),
  privateGet: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  recover: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@daytona/sdk", () => ({
  Daytona: class {
    get: typeof mocks.existingGet;
    create = mocks.create;
    list = mocks.list;
    constructor(config: { requestTimeoutMs?: number }) {
      mocks.construct(config);
      this.get = config.requestTimeoutMs === undefined ? mocks.existingGet : mocks.privateGet;
    }
  },
}));
vi.mock("@/lib/security/execution-context", () => ({
  ExecutionAuthorizationError: class extends Error {
    constructor(readonly status: number, message: string) { super(message); }
  },
}));

import { DaytonaProvider } from "@/lib/workspace/providers/daytona";

const configuration = { apiKey: "synthetic-test-provider-key", apiUrl: "https://daytona.invalid" };
const unavailable = { status: 503, message: "The registered workspace is unavailable." };

function sandbox(id = "registered-sandbox", state = "started") {
  return { id, state, process: { marker: "bounded-process" }, start: mocks.start,
    recover: mocks.recover, delete: mocks.remove };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.privateGet.mockResolvedValue(sandbox());
});

describe("private file-session provider transport", () => {
  it("lazily creates a bounded client and retrieves only the exact existing sandbox", async () => {
    const provider = new DaytonaProvider(configuration);
    expect(mocks.construct.mock.calls).toEqual([[configuration]]);
    await expect(provider.getPrivateFileSessionProcess("registered-sandbox"))
      .resolves.toEqual({ marker: "bounded-process" });
    expect(mocks.construct.mock.calls).toEqual([[configuration], [{ ...configuration,
      requestTimeoutMs: 5_000, useDeprecatedPolling: true }]]);
    expect(mocks.privateGet).toHaveBeenCalledExactlyOnceWith("registered-sandbox");
    for (const action of [mocks.existingGet, mocks.create, mocks.list, mocks.start, mocks.recover, mocks.remove]) {
      expect(action).not.toHaveBeenCalled();
    }
  });

  it("reuses the scoped transport client while retrieving current sandbox state each time", async () => {
    const provider = new DaytonaProvider(configuration);
    await provider.getPrivateFileSessionProcess("registered-sandbox");
    mocks.privateGet.mockResolvedValueOnce(sandbox("registered-sandbox", "stopped"));
    await expect(provider.getPrivateFileSessionProcess("registered-sandbox")).rejects.toMatchObject(unavailable);
    expect(mocks.construct).toHaveBeenCalledTimes(2);
    expect(mocks.privateGet).toHaveBeenCalledTimes(2);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("leaves the existing client and ordinary process adapter unchanged", async () => {
    const provider = new DaytonaProvider(configuration);
    const existing = sandbox("inactive-sandbox", "stopped");
    mocks.existingGet.mockResolvedValue(existing);
    await provider.getPrivateFileSessionProcess("registered-sandbox");
    await expect(provider.getSandbox("inactive-sandbox")).resolves.toBe(existing);
    expect(provider.getSandboxProcess(existing as never)).toBe(existing.process);
    expect(mocks.existingGet).toHaveBeenCalledExactlyOnceWith("inactive-sandbox");
    expect(mocks.construct.mock.calls[0]).toEqual([configuration]);
  });

  it.each(["", "   ", "x".repeat(257), "é".repeat(129), "bad\0id", null, undefined, 123])(
    "rejects invalid sandbox identifiers before initializing the scoped client: %s", async (id) => {
      const provider = new DaytonaProvider(configuration);
      await expect(provider.getPrivateFileSessionProcess(id as string)).rejects.toMatchObject(unavailable);
      expect(mocks.construct).toHaveBeenCalledTimes(1);
      expect(mocks.privateGet).not.toHaveBeenCalled();
    },
  );

  it("accepts the maximum bounded identifier without rewriting it", async () => {
    const provider = new DaytonaProvider(configuration);
    const id = "x".repeat(256);
    mocks.privateGet.mockResolvedValue(sandbox(id));
    await provider.getPrivateFileSessionProcess(id);
    expect(mocks.privateGet).toHaveBeenCalledExactlyOnceWith(id);
  });

  it.each(["starting", "stopped", "error", "build_failed", "unknown"])(
    "does not start, recover, replace, or remove a sandbox in state %s", async (state) => {
      const provider = new DaytonaProvider(configuration);
      mocks.privateGet.mockResolvedValue(sandbox("registered-sandbox", state));
      await expect(provider.getPrivateFileSessionProcess("registered-sandbox")).rejects.toMatchObject(unavailable);
      for (const action of [mocks.create, mocks.list, mocks.start, mocks.recover, mocks.remove]) {
        expect(action).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects an SDK lookup that resolves a name or identifier to a different sandbox", async () => {
    const provider = new DaytonaProvider(configuration);
    mocks.privateGet.mockResolvedValue(sandbox("unrelated-sandbox"));
    await expect(provider.getPrivateFileSessionProcess("registered-sandbox")).rejects.toMatchObject(unavailable);
  });

  it("sanitizes lookup and construction errors without attaching provider details", async () => {
    const provider = new DaytonaProvider(configuration);
    const sensitive = "provider request included synthetic private source content";
    mocks.construct.mockImplementationOnce(() => { throw new Error(sensitive); });
    await expect(provider.getPrivateFileSessionProcess("registered-sandbox")).rejects.toMatchObject(unavailable);
    mocks.privateGet.mockRejectedValueOnce(new Error(sensitive));
    const error = await provider.getPrivateFileSessionProcess("registered-sandbox").catch((failure) => failure);
    expect(error).toMatchObject(unavailable);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(sensitive);
  });
});
