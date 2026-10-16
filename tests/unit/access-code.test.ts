import { scrypt, timingSafeEqual } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scrypt: vi.fn(actual.scrypt),
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

import {
  AccessCodeFormatError,
  assertAccessCodeInput,
  DUMMY_ACCESS_CODE_HASH,
  hashAccessCode,
  isAccessCodeInput,
  verifyAccessCode,
} from "@/lib/security/access-code";

const code = "synthetic test access code";
let encoded: string;

beforeAll(async () => {
  encoded = await hashAccessCode(code);
});

beforeEach(() => vi.clearAllMocks());

describe("access-code scrypt hashing", () => {
  it("uses the actual asynchronous KDF and constant-time comparison for correct and wrong codes", async () => {
    await expect(verifyAccessCode(code, encoded)).resolves.toBe(true);
    await expect(verifyAccessCode("incorrect test access code", encoded)).resolves.toBe(false);
    await expect(verifyAccessCode("x", encoded)).resolves.toBe(false);
    expect(scrypt).toHaveBeenCalledTimes(3);
    expect(scrypt).toHaveBeenCalledWith(code, expect.any(Buffer), 64,
      { N: 32_768, r: 8, p: 3, maxmem: 67_108_864 }, expect.any(Function));
    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
    for (const [candidate, stored] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(candidate).toHaveLength(64);
      expect(stored).toHaveLength(64);
    }
  });

  it("generates fresh 32-byte salts and canonical 64-byte keys", async () => {
    const another = await hashAccessCode(code);
    expect(another).not.toBe(encoded);
    const firstFields = encoded.split("$");
    const nextFields = another.split("$");
    expect(firstFields.slice(0, 5)).toEqual(["", "cr8or", "scrypt", "v=1", "N=32768,r=8,p=3"]);
    expect(nextFields[5]).not.toBe(firstFields[5]);
    expect(Buffer.from(nextFields[5], "base64url")).toHaveLength(32);
    expect(Buffer.from(nextFields[6], "base64url")).toHaveLength(64);
    expect(Buffer.from(nextFields[5], "base64url").toString("base64url")).toBe(nextFields[5]);
    expect(Buffer.from(nextFields[6], "base64url").toString("base64url")).toBe(nextFields[6]);
    expect(another).not.toContain(code);
    await expect(verifyAccessCode(code, another)).resolves.toBe(true);
  });

  it("preserves leading and trailing whitespace", async () => {
    const spacedCode = `  ${code}\t\n`;
    const spacedHash = await hashAccessCode(spacedCode);
    await expect(verifyAccessCode(spacedCode, spacedHash)).resolves.toBe(true);
    await expect(verifyAccessCode(spacedCode.trim(), spacedHash)).resolves.toBe(false);
  });

  it("does not normalize Unicode credentials", async () => {
    const composed = "caf\u00e9".repeat(4);
    const composedHash = await hashAccessCode(composed);
    await expect(verifyAccessCode(composed, composedHash)).resolves.toBe(true);
    await expect(verifyAccessCode(composed.normalize("NFD"), composedHash)).resolves.toBe(false);
  });

  it("derives the public dummy hash from synthetic data and performs real verification work", async () => {
    await expect(verifyAccessCode("cr8or-public-dummy-access-code-v1", DUMMY_ACCESS_CODE_HASH)).resolves.toBe(true);
    await expect(verifyAccessCode(code, DUMMY_ACCESS_CODE_HASH)).resolves.toBe(false);
    expect(scrypt).toHaveBeenCalledTimes(2);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });
});

describe("access-code input bounds", () => {
  it.each([undefined, null, 16, {}, [], "", "a".repeat(1_025), "\u00e9".repeat(513), "\u{1f511}".repeat(257)])(
    "rejects invalid or oversized input before the KDF (case %#)", async (input) => {
      expect(isAccessCodeInput(input)).toBe(false);
      expect(() => assertAccessCodeInput(input as string)).toThrow(TypeError);
      await expect(hashAccessCode(input as string)).rejects.toThrow(TypeError);
      await expect(verifyAccessCode(input as string, encoded)).resolves.toBe(false);
      expect(scrypt).not.toHaveBeenCalled();
      expect(timingSafeEqual).not.toHaveBeenCalled();
    },
  );

  it.each(["x", "1234", "123456", "12345678", "Studio2026", "a long synthetic owner-selected passphrase", " ", "\u{1f511}"])(
    "hashes and verifies any nonempty owner-selected code (case %#)", async (input) => {
      expect(isAccessCodeInput(input)).toBe(true);
      expect(() => assertAccessCodeInput(input)).not.toThrow();
      const hash = await hashAccessCode(input);
      await expect(verifyAccessCode(input, hash)).resolves.toBe(true);
      await expect(verifyAccessCode(`${input}x`, hash)).resolves.toBe(false);
      expect(scrypt).toHaveBeenCalledTimes(3);
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["\ud800", "\udfff", "\udc00\ud800", "\ud800X", "\ud800\ud800", "\udc00\udc00", "\ud800😀"])(
    "rejects unpaired UTF-16 surrogates before hashing or verification (case %#)", async (suffix) => {
      const malformed = `${code}${suffix}`;
      expect(isAccessCodeInput(malformed)).toBe(false);
      expect(() => assertAccessCodeInput(malformed)).toThrow(TypeError);
      await expect(hashAccessCode(malformed)).rejects.toThrow(TypeError);
      await expect(verifyAccessCode(malformed, encoded)).resolves.toBe(false);
      expect(scrypt).not.toHaveBeenCalled();
      expect(timingSafeEqual).not.toHaveBeenCalled();
    },
  );

  it.each(["a", "\u{1f511}", " ", "a".repeat(1_024), "\u00e9".repeat(512), "\u{1f511}".repeat(256)])(
    "accepts nonempty input and exact UTF-8 byte boundaries without trimming (case %#)", (input) => {
      expect(isAccessCodeInput(input)).toBe(true);
      expect(() => assertAccessCodeInput(input)).not.toThrow();
    },
  );

  it("hashes and verifies the maximum 1024-byte Unicode credential", async () => {
    const maximumCode = "\u{1f511}".repeat(256);
    const maximumHash = await hashAccessCode(maximumCode);
    await expect(verifyAccessCode(maximumCode, maximumHash)).resolves.toBe(true);
  });

  it("preserves valid surrogate pairs and distinguishes literal replacement characters", async () => {
    const valid = `${code}\ud800\udc00\udbff\udfff\ufffd`;
    const validHash = await hashAccessCode(valid);
    await expect(verifyAccessCode(valid, validHash)).resolves.toBe(true);
    await expect(verifyAccessCode(`${code}\ufffd\ufffd\ufffd`, validHash)).resolves.toBe(false);
  });
});

describe("stored access-code format bounds", () => {
  const saltAndKey = DUMMY_ACCESS_CODE_HASH.slice(DUMMY_ACCESS_CODE_HASH.indexOf("$", 17) + 1);
  const malformed = [
    ["missing hash", ""],
    ["plaintext", code],
    ["unbounded encoding", "a".repeat(100_000)],
    ["unknown version", DUMMY_ACCESS_CODE_HASH.replace("v=1", "v=2")],
    ["wrong algorithm", DUMMY_ACCESS_CODE_HASH.replace("scrypt", "sha256")],
    ["unsafe memory cost", DUMMY_ACCESS_CODE_HASH.replace("N=32768", "N=999999999999")],
    ["weakened memory cost", DUMMY_ACCESS_CODE_HASH.replace("N=32768", "N=16384")],
    ["noncanonical memory cost", DUMMY_ACCESS_CODE_HASH.replace("N=32768", "N=032768")],
    ["wrong block size", DUMMY_ACCESS_CODE_HASH.replace("r=8", "r=9")],
    ["wrong parallelism", DUMMY_ACCESS_CODE_HASH.replace("p=3", "p=1")],
    ["negative cost", DUMMY_ACCESS_CODE_HASH.replace("p=3", "p=-1")],
    ["extra parameter", DUMMY_ACCESS_CODE_HASH.replace("p=3", "p=3,maxmem=1")],
    ["reordered parameters", DUMMY_ACCESS_CODE_HASH.replace("N=32768,r=8,p=3", "p=3,r=8,N=32768")],
    ["extra field", `${DUMMY_ACCESS_CODE_HASH}$extra`],
    ["trailing newline", `${DUMMY_ACCESS_CODE_HASH}\n`],
    ["truncated key", DUMMY_ACCESS_CODE_HASH.slice(0, -1)],
    ["base64 padding", `${DUMMY_ACCESS_CODE_HASH}==`],
    ["invalid salt character", DUMMY_ACCESS_CODE_HASH.replace("$Y3I4", "$!3I4")],
    ["noncanonical salt padding bits", DUMMY_ACCESS_CODE_HASH.replace("HQtdjE$", "HQtdjF$")],
    ["noncanonical key padding bits", `${DUMMY_ACCESS_CODE_HASH.slice(0, -1)}x`],
    ["extra algorithm prefix", `$scrypt$${saltAndKey}`],
  ];

  it.each(malformed)("rejects %s before KDF or comparison", async (_description, hash) => {
    await expect(verifyAccessCode(code, hash)).rejects.toEqual(new AccessCodeFormatError());
    expect(scrypt).not.toHaveBeenCalled();
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("rejects runtime non-string hashes with a sanitized error", async () => {
    await expect(verifyAccessCode(code, null as unknown as string)).rejects.toEqual(new AccessCodeFormatError());
    expect(new AccessCodeFormatError()).not.toHaveProperty("cause");
    expect(scrypt).not.toHaveBeenCalled();
  });
});
