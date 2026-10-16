import "server-only";

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const MAX_CODE_BYTES = 1_024;
const MIN_CODE_POINTS = 16;
const SALT_BYTES = 32;
const KEY_BYTES = 64;
// OWASP's scrypt N=2^15, r=8, p=3 option uses about 32 MiB per derivation.
// The 64 MiB allocation ceiling leaves room for scrypt's internal overhead.
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1_024 * 1_024 } as const;
const HASH_PREFIX = "$cr8or$scrypt$v=1$N=32768,r=8,p=3$";
const ENCODED_LENGTH = HASH_PREFIX.length + 43 + 1 + 86;
const ENCODED_FIELDS = /^([A-Za-z0-9_-]{43})\$([A-Za-z0-9_-]{86})$/;

/** Safe to surface internally without including the stored hash or submitted code. */
export class AccessCodeFormatError extends Error {
  constructor() {
    super("Stored access-code hash has an unsupported or invalid format.");
    this.name = "AccessCodeFormatError";
  }
}

/** Public synthetic fixture for an absent owner; callers must still require an owner record. */
export const DUMMY_ACCESS_CODE_HASH =
  "$cr8or$scrypt$v=1$N=32768,r=8,p=3$Y3I4b3ItcHVibGljLWR1bW15LW93bmVyLXNhbHQtdjE$Szggb0dmvAJf2DpHxl2bArC3F2YKKvu04KC2Io9U3lzpkUOxOS5jFDTvC5OqAeV_ERFRyFiWiUjscIl-Juc85w";

/** Verification accepts existing short codes, but always bounds input before the KDF. */
export function isAccessCodeInput(value: unknown): value is string {
  // In Unicode mode, this range matches only unpaired UTF-16 surrogates.
  // Reject them before Node's UTF-8 encoder silently substitutes U+FFFD.
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CODE_BYTES &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_CODE_BYTES;
}

/** Count Unicode code points, not UTF-16 units; never trim or normalize a credential. */
export function assertStrongAccessCode(code: string): void {
  if (!isAccessCodeInput(code) || Array.from(code).length < MIN_CODE_POINTS) {
    throw new TypeError("Access codes must contain valid Unicode, at least 16 characters, and at most 1024 UTF-8 bytes.");
  }
}

function deriveKey(code: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(code, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function decodeHash(encoded: string): { salt: Buffer; key: Buffer } {
  // Bound work before parsing, decoding, or interpreting any stored parameters.
  if (typeof encoded !== "string" || encoded.length !== ENCODED_LENGTH || !encoded.startsWith(HASH_PREFIX)) {
    throw new AccessCodeFormatError();
  }
  const fields = ENCODED_FIELDS.exec(encoded.slice(HASH_PREFIX.length));
  if (!fields) throw new AccessCodeFormatError();
  const salt = Buffer.from(fields[1], "base64url");
  const key = Buffer.from(fields[2], "base64url");
  // Node's base64 decoder is permissive; round trips reject padding bits and aliases.
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES ||
      salt.toString("base64url") !== fields[1] || key.toString("base64url") !== fields[2]) {
    throw new AccessCodeFormatError();
  }
  return { salt, key };
}

export async function hashAccessCode(code: string): Promise<string> {
  assertStrongAccessCode(code);
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(code, salt);
  return `${HASH_PREFIX}${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Invalid stored hashes fail closed; incorrect credentials return false. */
export async function verifyAccessCode(code: string, encoded: string): Promise<boolean> {
  const { salt, key } = decodeHash(encoded);
  if (!isAccessCodeInput(code)) return false;
  const candidate = await deriveKey(code, salt);
  return timingSafeEqual(candidate, key);
}
