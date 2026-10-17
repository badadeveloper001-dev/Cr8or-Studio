import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: database }));
vi.mock("@/lib/security/execution-context", () => ({
  ExecutionAuthorizationError: class extends Error {
    constructor(readonly status: number, message = "Authentication required.") { super(message); }
  },
}));

import {
  cleanupCompletedGitOperations, finishGitOperation, markGitDispatched, readGitOperation, reserveGitOperation,
  type ReserveGitOperationInput,
} from "@/lib/security/git-operation-store";

function input(): ReserveGitOperationInput {
  return { id: randomUUID(), executionId: randomUUID(), projectId: "registered", workspaceId: "daytona-fixture",
    repositoryKey: "fixture/project", operationKey: "commit", scopeDigest: "a".repeat(64), actorId: "frontend" };
}

beforeEach(() => { vi.resetAllMocks(); });

describe("Git mutation persistence fail-closed input and infrastructure handling", () => {
  it.each([
    { operationKey: "status" }, { operationKey: "git push --force" }, { operationKey: "commit;curl example.com" },
    { repositoryKey: "https://token@github.com/fixture/project" }, { repositoryKey: "Fixture/Project" },
    { repositoryKey: "fixture/project/other" }, { repositoryKey: "" }, { repositoryKey: null },
    { workspaceId: "" }, { workspaceId: "x\0y" }, { projectId: "" },
    { actorId: "../owner" }, { actorId: "a".repeat(65) }, { scopeDigest: "not-a-digest" },
    { scopeDigest: "A".repeat(64) }, { scopeDigest: null }, { id: "forged" }, { executionId: "forged" },
  ])("rejects invalid coordination metadata without database work: %j", async (patch) => {
    await expect(reserveGitOperation({ ...input(), ...patch } as ReserveGitOperationInput)).rejects.toMatchObject({ status: 409 });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "invalid"])("rejects malformed reservation input %s", async (invalid) => {
    await expect(reserveGitOperation(invalid as unknown as ReserveGitOperationInput)).rejects.toMatchObject({ status: 409 });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it.each(["stage", "unstage", "commit", "push", "create-branch", "create-pr", "upsert-file"])(
    "denies %s when shared coordination is unavailable, without exposing database details", async (operationKey) => {
      database.$transaction.mockRejectedValue(new Error("postgresql://secret-password@private-host SQL with credentials"));
      const error = await reserveGitOperation({ ...input(), operationKey }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ status: 503, message: "Git coordination is unavailable." });
      expect(JSON.stringify(error)).not.toContain("secret-password");
      expect(String(error)).not.toContain("private-host");
    });

  it("never reports a duplicate dispatch claim as successful", async () => {
    database.$executeRaw.mockResolvedValue(0);
    await expect(markGitDispatched(randomUUID())).rejects.toMatchObject({ status: 409 });
  });

  it("sanitizes failures from dispatch, lookup, completion and cleanup", async () => {
    const internal = new Error("sensitive query, provider credential and application environment");
    database.$executeRaw.mockRejectedValue(internal);
    database.$queryRaw.mockRejectedValue(internal);
    database.$transaction.mockRejectedValue(internal);
    for (const operation of [
      () => markGitDispatched(randomUUID()), () => readGitOperation(randomUUID()),
      () => finishGitOperation(randomUUID(), { status: "UNKNOWN" }), () => cleanupCompletedGitOperations(),
    ]) {
      const error = await operation().catch((failure: unknown) => failure);
      expect(error).toMatchObject({ status: 503, message: "Git coordination is unavailable." });
      expect(String(error)).not.toContain("sensitive query");
    }
  });

  it("rejects a successful receipt with an absent or nonzero exit code", async () => {
    await expect(finishGitOperation(randomUUID(), { status: "SUCCEEDED" })).rejects.toMatchObject({ status: 409 });
    await expect(finishGitOperation(randomUUID(), { status: "SUCCEEDED", exitCode: 1 })).rejects.toMatchObject({ status: 409 });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it.each([0, -1, 3651, 1.5, Number.NaN])("rejects cleanup windows %s that could discard coordination history", async (days) => {
    await expect(cleanupCompletedGitOperations(days)).rejects.toMatchObject({ status: 409 });
    expect(database.$executeRaw).not.toHaveBeenCalled();
  });
});
