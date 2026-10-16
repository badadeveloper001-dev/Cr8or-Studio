import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hash: vi.fn(), query: vi.fn(), transaction: vi.fn(),
  transactionQuery: vi.fn(), transactionExecute: vi.fn(),
}));

vi.mock("@/lib/security/access-code", () => ({ hashAccessCode: mocks.hash }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {
  $queryRaw: mocks.query, $transaction: mocks.transaction,
} }));

import {
  inspectOwnerStatus, OwnerManagementError, provisionOwner, rotateOwnerAccessCode,
} from "@/lib/security/owner-management";

const code = "  synthetic test access code  ";
const hash = "synthetic-stored-hash";
const metadata = {
  credentialVersion: 1,
  createdAt: new Date("2030-01-01T00:00:00.000Z"),
  updatedAt: new Date("2030-01-01T00:00:00.000Z"),
};

describe("owner management", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hash.mockResolvedValue(hash);
    mocks.query.mockResolvedValue([metadata]);
    mocks.transactionQuery.mockResolvedValue([{ ...metadata, credentialVersion: 2 }]);
    mocks.transactionExecute.mockResolvedValue(3);
    mocks.transaction.mockImplementation(async (operation) => operation({
      $queryRaw: mocks.transactionQuery, $executeRaw: mocks.transactionExecute,
    }));
  });

  it("provisions only the singleton with a hash and fresh 32-byte handle", async () => {
    expect(await provisionOwner(code)).toEqual(metadata);
    await provisionOwner(code);
    expect(mocks.hash).toHaveBeenCalledWith(code);
    const first = mocks.query.mock.calls[0];
    const second = mocks.query.mock.calls[1];
    expect(first[0].join("?")).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(first.slice(1)).toEqual(["owner", hash, expect.any(Buffer)]);
    expect(first[3]).toHaveLength(32);
    expect(first[3]).not.toEqual(second[3]);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(code);
    expect(mocks.hash.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
  });

  it("reports already provisioned without overwriting the existing row", async () => {
    mocks.query.mockResolvedValue([]);
    await expect(provisionOwner(code)).rejects.toEqual(new OwnerManagementError("ALREADY_PROVISIONED"));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("hashes before the rotation transaction, updates the generation, and revokes under its lock", async () => {
    expect(await rotateOwnerAccessCode(code)).toEqual({ ...metadata, credentialVersion: 2, revokedCount: 3 });
    expect(mocks.hash.mock.invocationCallOrder[0]).toBeLessThan(mocks.transaction.mock.invocationCallOrder[0]);
    expect(mocks.transactionQuery.mock.invocationCallOrder[0]).toBeLessThan(mocks.transactionExecute.mock.invocationCallOrder[0]);
    const update = mocks.transactionQuery.mock.calls[0];
    expect(update[0].join("?")).toContain('"credentialVersion" = "credentialVersion" + 1');
    expect(update[0].join("?")).not.toContain("webAuthnUserHandle");
    expect(update.slice(1)).toEqual([hash, "owner"]);
    expect(mocks.transactionExecute.mock.calls[0][0].join("?")).toContain('"revokedAt" IS NULL');
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("does not revoke sessions when the owner has not been provisioned", async () => {
    mocks.transactionQuery.mockResolvedValue([]);
    await expect(rotateOwnerAccessCode(code)).rejects.toEqual(new OwnerManagementError("OWNER_NOT_PROVISIONED"));
    expect(mocks.transactionExecute).not.toHaveBeenCalled();
  });

  it("rejects invalid access codes before database access", async () => {
    const policyError = new TypeError("Access code does not meet the policy.");
    mocks.hash.mockRejectedValue(policyError);
    await expect(provisionOwner("")).rejects.toBe(policyError);
    await expect(rotateOwnerAccessCode("")).rejects.toBe(policyError);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("returns only nonsecret status metadata and aggregate counts", async () => {
    mocks.query.mockResolvedValue([{ ...metadata, total: 5, active: 2, revoked: 2, expired: 1,
      accessCodeHash: "must-not-escape", webAuthnUserHandle: Buffer.alloc(32), tokenHash: "must-not-escape",
    }]);
    expect(await inspectOwnerStatus()).toEqual({
      provisioned: true, ...metadata, sessions: { total: 5, active: 2, revoked: 2, expired: 1 },
    });
    const query = mocks.query.mock.calls[0][0].join("?");
    expect(query).not.toMatch(/accessCodeHash|webAuthnUserHandle|tokenHash/);
    expect(query).toContain('s."credentialVersion" = o."credentialVersion"');
  });

  it("reports an unprovisioned installation without inventing owner metadata", async () => {
    mocks.query.mockResolvedValue([]);
    expect(await inspectOwnerStatus()).toEqual({
      provisioned: false, credentialVersion: null, createdAt: null, updatedAt: null,
      sessions: { total: 0, active: 0, revoked: 0, expired: 0 },
    });
  });

  it("sanitizes database errors, including failed session revocation", async () => {
    const sensitive = new Error("postgresql://private-connection synthetic-secret-hash");
    mocks.query.mockRejectedValue(sensitive);
    mocks.transactionExecute.mockRejectedValue(sensitive);
    for (const operation of [() => provisionOwner(code), () => rotateOwnerAccessCode(code), inspectOwnerStatus]) {
      await expect(operation()).rejects.toEqual(new OwnerManagementError("UNAVAILABLE"));
      try { await operation(); } catch (error) { expect(error).not.toHaveProperty("cause"); }
    }
  });
});
