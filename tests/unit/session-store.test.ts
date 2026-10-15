import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), execute: vi.fn(), transaction: vi.fn(),
  transactionQuery: vi.fn(), transactionExecute: vi.fn(), create: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: {
  $queryRaw: mocks.query,
  $executeRaw: mocks.execute,
  $transaction: mocks.transaction,
} }));

import {
  cleanupExpiredSessions, createOwnerSession, hashSessionToken, resolveOwnerSession,
  resolveSessionByTokenHash, revokeAllOwnerSessions, revokeSession, SessionStoreError,
} from "@/lib/security/session-store";

const now = new Date("2030-01-01T00:00:00.000Z");
const input = {
  credentialVersion: 1,
  authenticationMethod: "ACCESS_CODE" as const,
  expiresAt: new Date("2030-01-01T12:00:00.000Z"),
};
const session = {
  id: "session-id", ownerId: "owner", credentialVersion: 1,
  authenticationMethod: "ACCESS_CODE", authenticatedAt: now, createdAt: now,
  expiresAt: input.expiresAt, revokedAt: null, lastActiveAt: null,
};

describe("session persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.transaction.mockImplementation(async (operation) => operation({
      $queryRaw: mocks.transactionQuery,
      $executeRaw: mocks.transactionExecute,
      authSession: { create: mocks.create },
    }));
    mocks.transactionQuery.mockResolvedValueOnce([{ credentialVersion: 1 }]).mockResolvedValueOnce([{ now }]);
    mocks.create.mockResolvedValue(session);
  });

  it("hashes the canonical opaque token with SHA-256", () => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    expect(hashSessionToken(token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
  });

  it.each(["", "short", "a".repeat(44), `${"A".repeat(43)}\n`, `${"A".repeat(42)}B`])(
    "rejects malformed or noncanonical tokens without accessing storage: %j", async (token) => {
      expect(() => hashSessionToken(token)).toThrow(TypeError);
      expect(await resolveOwnerSession(token)).toBeNull();
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );

  it("returns a fresh 32-byte token while writing only its digest", async () => {
    const created = await createOwnerSession(input);
    expect(Buffer.from(created.token, "base64url")).toHaveLength(32);
    expect(created.session).toEqual(session);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: {
      ownerId: "owner", tokenHash: hashSessionToken(created.token), credentialVersion: 1,
      authenticationMethod: "ACCESS_CODE", authenticatedAt: now, createdAt: now,
      expiresAt: input.expiresAt,
    } }));
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(created.token);
    expect(created.session).not.toHaveProperty("tokenHash");
  });

  it("does not create a session for an unprovisioned owner", async () => {
    mocks.transactionQuery.mockReset().mockResolvedValue([]);
    await expect(createOwnerSession(input)).rejects.toMatchObject({ code: "OWNER_NOT_PROVISIONED" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("requires the version that was actually verified, not whichever version is current", async () => {
    mocks.transactionQuery.mockReset().mockResolvedValue([{ credentialVersion: 2 }]);
    await expect(createOwnerSession(input)).rejects.toMatchObject({ code: "CREDENTIAL_VERSION_CHANGED" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects an expiration that has already passed on the database clock", async () => {
    await expect(createOwnerSession({ ...input, expiresAt: now })).rejects.toMatchObject({ code: "INVALID_EXPIRATION" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects invalid creation input before a transaction", async () => {
    await expect(createOwnerSession({ ...input, credentialVersion: 0 })).rejects.toThrow(TypeError);
    await expect(createOwnerSession({ ...input, expiresAt: new Date(NaN) })).rejects.toThrow(TypeError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("looks up only the digest and does not cache resolution between requests", async () => {
    const token = Buffer.alloc(32, 9).toString("base64url");
    mocks.query.mockResolvedValueOnce([session]).mockResolvedValueOnce([]);
    expect(await resolveOwnerSession(token)).toEqual(session);
    expect(await resolveOwnerSession(token)).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0].slice(1)).toContain(hashSessionToken(token));
    expect(mocks.query.mock.calls[0].slice(1)).not.toContain(token);
  });

  it("rejects malformed digests without database access", async () => {
    expect(await resolveSessionByTokenHash(`${"a".repeat(64)}\n`)).toBeNull();
    expect(await resolveSessionByTokenHash("A".repeat(64))).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns the persisted revocation and cleanup counts", async () => {
    mocks.execute.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    expect(await revokeSession("session-id")).toBe(1);
    expect(await revokeSession("session-id")).toBe(0);
    expect(await cleanupExpiredSessions()).toBe(2);
  });

  it("revokes all sessions and advances the generation in one transaction", async () => {
    mocks.transactionQuery.mockReset().mockResolvedValue([{ credentialVersion: 2 }]);
    mocks.transactionExecute.mockResolvedValue(3);
    expect(await revokeAllOwnerSessions()).toEqual({ revokedCount: 3, credentialVersion: 2 });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.transactionExecute).toHaveBeenCalledOnce();
  });

  it("propagates sanitized storage failures instead of an unauthenticated fallback", async () => {
    const sensitiveError = new Error("private connection details and token inputs");
    mocks.query.mockRejectedValue(sensitiveError);
    mocks.execute.mockRejectedValue(sensitiveError);
    mocks.transaction.mockRejectedValue(sensitiveError);
    for (const operation of [
      () => resolveSessionByTokenHash("a".repeat(64)),
      () => createOwnerSession(input),
      () => revokeSession("session-id"),
      () => revokeAllOwnerSessions(),
      () => cleanupExpiredSessions(),
    ]) {
      await expect(operation()).rejects.toEqual(new SessionStoreError("UNAVAILABLE"));
    }
  });
});
