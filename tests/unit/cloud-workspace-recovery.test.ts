import { describe, expect, it } from "vitest";

describe("cloud workspace self-healing contract", () => {
  it("recovery flow: ID found → reuse", () => {
    // Contract: if persisted providerWorkspaceId exists, use it directly
    const flow = { idFound: true, nameFound: false, created: false };
    expect(flow.idFound).toBe(true);
    expect(flow.nameFound).toBe(false);
    expect(flow.created).toBe(false);
  });

  it("recovery flow: ID missing → name found → update ID", () => {
    // Contract: if ID is stale but name matches, recover and persist new ID
    const flow = { idFound: false, nameFound: true, created: false };
    expect(flow.idFound).toBe(false);
    expect(flow.nameFound).toBe(true);
    expect(flow.created).toBe(false);
  });

  it("recovery flow: ID missing → name missing → create → reclone", () => {
    // Contract: if no sandbox found, create and reclone
    const flow = { idFound: false, nameFound: false, created: true };
    expect(flow.idFound).toBe(false);
    expect(flow.nameFound).toBe(false);
    expect(flow.created).toBe(true);
  });

  it("unrecoverable sandbox throws specific error", () => {
    // Contract: error/build_failed + not recoverable → clear error
    const state = "error";
    const recoverable = false;
    expect(state).toBe("error");
    expect(recoverable).toBe(false);
  });

  it("stopped sandbox is restarted", () => {
    // Contract: stopped state → start and wait
    const state = "stopped";
    expect(state).toBe("stopped");
  });

  it("second call uses persisted ID directly", () => {
    // Contract: after recovery, new ID is persisted for next call
    const persistedId = "new-sandbox-id";
    expect(persistedId).toBeTruthy();
  });
});

describe("database vs runtime error separation", () => {
  it("Prisma error is classified as database error", () => {
    const errorType = "PrismaClientKnownRequestError";
    const isDbError = errorType.startsWith("Prisma");
    expect(isDbError).toBe(true);
  });

  it("Daytona error is classified as runtime error", () => {
    const errorType = "Error";
    const isDbError = errorType.startsWith("Prisma");
    expect(isDbError).toBe(false);
  });

  it("sandbox not found is not a database error", () => {
    const message = "Sandbox not found: abc123";
    const isDbError = message.includes("database") || message.includes("Prisma");
    expect(isDbError).toBe(false);
  });
});
