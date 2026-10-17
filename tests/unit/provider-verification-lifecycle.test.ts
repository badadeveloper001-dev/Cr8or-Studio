import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createOfflineLifecycleAdapter, createOfflineLifecycleTimeoutAdapter, OFFLINE_CLONE_SANDBOX, OFFLINE_TIMEOUT_SANDBOX } from "../provider-verification/lifecycle-adapter";
import { createOfflineSandbox } from "../provider-verification/fixtures";
import { createOfflineSessionAdapter } from "../provider-verification/session-adapter";

describe("controlled lifecycle timeout boundary", () => {
  it("retains the exact created resource after an uncertain timeout and rejects automatic replacement", async () => {
    const adapter = createOfflineLifecycleTimeoutAdapter();
    const signal = new AbortController().signal;
    const identity = { operationId: "synthetic-timeout-operation", projectId: "synthetic-timeout-project", workspaceRecordId: "synthetic-timeout-registration" };
    await expect(adapter.provider.create(identity, signal)).rejects.toMatchObject({ code: "TIMED_OUT", uncertain: true });
    expect(await adapter.provider.inspect(OFFLINE_TIMEOUT_SANDBOX, signal)).toMatchObject({ id: OFFLINE_TIMEOUT_SANDBOX,
      state: "started", labels: { "cr8or-operation": identity.operationId, "cr8or-project": identity.projectId } });
    await expect(adapter.provider.create(identity, signal)).rejects.toThrow();
    await expect(adapter.provider.inspect("unexpected-sandbox", signal)).rejects.toThrow();
    expect(adapter.evidence().creates).toBe(1);
    expect(await adapter.provider.findCreated({ ...identity, projectId: "other-project" }, signal)).toEqual([]);
    await expect(adapter.provider.start(OFFLINE_TIMEOUT_SANDBOX, signal)).rejects.toThrow();
    await expect(adapter.provider.stop(OFFLINE_TIMEOUT_SANDBOX, signal)).rejects.toThrow();
    expect(adapter.evidence()).toEqual({ operations: 7, creates: 1, inspections: 1 });
  });

  it("does not create the synthetic resource after cancellation", async () => {
    const adapter = createOfflineLifecycleTimeoutAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.provider.create({ operationId: "cancelled", projectId: "cancelled", workspaceRecordId: "cancelled" }, controller.signal)).rejects.toThrow();
    expect(adapter.evidence().creates).toBe(0);
    expect(adapter.evidence().operations).toBe(1);
  });

  it("counts each controlled lifecycle call once, including rejected lookups and unsupported actions", async () => {
    const root = await createOfflineSandbox();
    const process = createOfflineSessionAdapter(root);
    try {
      const adapter = createOfflineLifecycleAdapter(process);
      const signal = new AbortController().signal;
      const identity = { operationId: "synthetic-count-operation", projectId: "synthetic-count-project", workspaceRecordId: "synthetic-count-registration" };
      await expect(adapter.provider.inspect("unexpected-sandbox", signal)).rejects.toThrow();
      await expect(adapter.sessionProvider.getPrivateGitSessionProcess("unexpected-sandbox")).rejects.toThrow();
      await adapter.provider.create(identity, signal);
      await adapter.provider.inspect(OFFLINE_CLONE_SANDBOX, signal);
      await adapter.provider.findCreated(identity, signal);
      await adapter.sessionProvider.getPrivateGitSessionProcess(OFFLINE_CLONE_SANDBOX);
      await expect(adapter.provider.start(OFFLINE_CLONE_SANDBOX, signal)).rejects.toThrow();
      await expect(adapter.provider.stop(OFFLINE_CLONE_SANDBOX, signal)).rejects.toThrow();
      expect(adapter.evidence()).toEqual({ operations: 8, creates: 1, inspections: 1, sessionBindings: 1 });
    } finally {
      await process.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
