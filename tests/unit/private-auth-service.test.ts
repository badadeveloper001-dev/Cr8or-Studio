import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), query: vi.fn(), findOwner: vi.fn(), verify: vi.fn(), createSession: vi.fn(),
  events: [] as string[],
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/security/access-code", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security/access-code")>(),
  verifyAccessCode: mocks.verify,
}));
vi.mock("@/lib/security/session-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security/session-store")>(),
  createOwnerSession: mocks.createSession,
}));

import { AccessCodeFormatError, DUMMY_ACCESS_CODE_HASH } from "@/lib/security/access-code";
import { authenticateOwnerAccessCode, PrivateAuthBusyError } from "@/lib/security/private-auth-service";
import { SessionStoreError } from "@/lib/security/session-store";

const accessCode = " exact submitted access code ";
const owner = { accessCodeHash: "stored-owner-hash", credentialVersion: 7 };
const now = new Date("2030-01-01T01:23:45.678Z");
const expiresAt = new Date("2030-01-01T13:23:45.678Z");
const created = { token: "opaque-session-token", session: { expiresAt } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.events.length = 0;
  mocks.transaction.mockImplementation(async (operation) => {
    const result = await operation({
      $queryRaw: mocks.query,
      ownerCredential: { findUnique: mocks.findOwner },
    });
    mocks.events.push("verification committed");
    return result;
  });
  mocks.query.mockResolvedValueOnce([{ acquired: true }]).mockResolvedValueOnce([{ now }]);
  mocks.findOwner.mockResolvedValue({ ...owner });
  mocks.verify.mockResolvedValue(true);
  mocks.createSession.mockImplementation(async () => {
    mocks.events.push("session creation");
    return created;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("private access-code authentication", () => {
  it.each(["", "x".repeat(1_025), "🔑".repeat(257), "unpaired\ud800"])(
    "rejects invalid input before database or KDF work (case %#)", async (input) => {
      await expect(authenticateOwnerAccessCode(input)).rejects.toThrow(TypeError);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
    },
  );

  it("requires available database verification capacity before owner lookup or hashing", async () => {
    mocks.query.mockReset().mockResolvedValue([{ acquired: false }]);
    await expect(authenticateOwnerAccessCode(accessCode)).rejects.toThrow(PrivateAuthBusyError);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.findOwner).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("passes the exact verified generation and database expiry after the verification transaction commits", async () => {
    await expect(authenticateOwnerAccessCode(accessCode)).resolves.toBe(created);
    expect(mocks.findOwner).toHaveBeenCalledOnce();
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(accessCode, owner.accessCodeHash);
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(mocks.findOwner.mock.invocationCallOrder[0]);
    expect(mocks.findOwner.mock.invocationCallOrder[0]).toBeLessThan(mocks.verify.mock.invocationCallOrder[0]);
    expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[1]);
    expect(mocks.createSession).toHaveBeenCalledExactlyOnceWith({
      credentialVersion: owner.credentialVersion,
      authenticationMethod: "ACCESS_CODE",
      expiresAt,
    });
    expect(mocks.events).toEqual(["verification committed", "session creation"]);
  });

  it.each([-86_400_000, 86_400_000])("does not use the application clock with %i ms skew", async (offset) => {
    const applicationClock = vi.spyOn(Date, "now").mockReturnValue(now.getTime() + offset);
    await authenticateOwnerAccessCode(accessCode);
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }));
    expect(applicationClock).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not authenticate a missing owner even when dummy verification returns %s", async (correct) => {
    mocks.findOwner.mockResolvedValue(null);
    mocks.verify.mockResolvedValue(correct);
    await expect(authenticateOwnerAccessCode(accessCode)).resolves.toBeNull();
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(accessCode, DUMMY_ACCESS_CODE_HASH);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each([false, true])("performs dummy KDF work for a malformed stored hash and rejects even when it returns %s", async (dummyCorrect) => {
    mocks.verify.mockRejectedValueOnce(new AccessCodeFormatError()).mockResolvedValueOnce(dummyCorrect);
    await expect(authenticateOwnerAccessCode(accessCode)).resolves.toBeNull();
    expect(mocks.verify).toHaveBeenNthCalledWith(1, accessCode, owner.accessCodeHash);
    expect(mocks.verify).toHaveBeenNthCalledWith(2, accessCode, DUMMY_ACCESS_CODE_HASH);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("rejects an incorrect code without reading the expiry clock or creating a session", async () => {
    mocks.verify.mockResolvedValue(false);
    await expect(authenticateOwnerAccessCode(accessCode)).resolves.toBeNull();
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each(["transaction", "capacity", "owner", "verification", "clock", "dummy"])(
    "propagates %s failure without creating a session", async (stage) => {
      const failure = new Error("synthetic infrastructure failure");
      if (stage === "transaction") mocks.transaction.mockRejectedValue(failure);
      if (stage === "capacity") mocks.query.mockReset().mockRejectedValue(failure);
      if (stage === "owner") mocks.findOwner.mockRejectedValue(failure);
      if (stage === "verification") mocks.verify.mockRejectedValue(failure);
      if (stage === "clock") {
        mocks.query.mockReset().mockResolvedValueOnce([{ acquired: true }]).mockRejectedValueOnce(failure);
      }
      if (stage === "dummy") {
        mocks.verify.mockRejectedValueOnce(new AccessCodeFormatError()).mockRejectedValueOnce(failure);
      }
      await expect(authenticateOwnerAccessCode(accessCode)).rejects.toBe(failure);
      expect(mocks.createSession).not.toHaveBeenCalled();
    },
  );

  it("does not create a session when the verification transaction fails to commit", async () => {
    const failure = new Error("synthetic transaction commit failure");
    mocks.transaction.mockImplementation(async (operation) => {
      await operation({ $queryRaw: mocks.query, ownerCredential: { findUnique: mocks.findOwner } });
      throw failure;
    });
    await expect(authenticateOwnerAccessCode(accessCode)).rejects.toBe(failure);
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each(["CREDENTIAL_VERSION_CHANGED", "OWNER_NOT_PROVISIONED", "UNAVAILABLE"] as const)(
    "propagates %s from session creation without retrying authentication", async (code) => {
      const failure = new SessionStoreError(code);
      mocks.createSession.mockRejectedValue(failure);
      await expect(authenticateOwnerAccessCode(accessCode)).rejects.toBe(failure);
      expect(mocks.createSession).toHaveBeenCalledOnce();
      expect(mocks.findOwner).toHaveBeenCalledOnce();
      expect(mocks.verify).toHaveBeenCalledOnce();
    },
  );
});
