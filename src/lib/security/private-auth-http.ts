import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { isAccessCodeInput } from "@/lib/security/access-code";

const MAX_BODY_BYTES = 4_096;
const SECURE_COOKIE_NAME = "__Host-cr8or-session";
const LOCAL_COOKIE_NAME = "cr8or-dev-session";

export type PrivateAuthConfig = {
  origin: string;
  rateLimitKey: Buffer;
  production: boolean;
};

/** These errors deliberately contain no environment values or underlying cause. */
export class PrivateAuthUnavailableError extends Error {
  constructor() {
    super("Authentication is unavailable.");
    this.name = "PrivateAuthUnavailableError";
  }
}

export class PrivateAuthMutationError extends Error {
  constructor() {
    super("Invalid authentication request.");
    this.name = "PrivateAuthMutationError";
  }
}

export class PrivateAuthRequestError extends Error {
  constructor() {
    super("Invalid request payload.");
    this.name = "PrivateAuthRequestError";
  }
}

/** Read at request time: an import must not enable auth or retain stale config. */
export function readPrivateAuthConfig(): PrivateAuthConfig {
  if (process.env.CR8OR_PRIVATE_AUTH_ENABLED !== "true") {
    throw new PrivateAuthUnavailableError();
  }

  const origin = process.env.CR8OR_PRIVATE_AUTH_ORIGIN;
  const encodedKey = process.env.CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY;
  const deployed = Boolean(
    process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL || process.env.VERCEL_DEPLOYMENT_ID,
  );
  const production = process.env.NODE_ENV === "production" || deployed;

  let url: URL;
  try {
    if (!origin) throw new PrivateAuthUnavailableError();
    url = new URL(origin);
  } catch {
    throw new PrivateAuthUnavailableError();
  }

  // Exact serialization rejects paths, credentials, whitespace, default ports,
  // host aliases, and other inputs the URL parser would silently normalize.
  if (origin !== url.origin) throw new PrivateAuthUnavailableError();
  const localHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    ["development", "test"].includes(process.env.NODE_ENV ?? "") && !production;
  if (url.protocol !== "https:" && !localHttp) throw new PrivateAuthUnavailableError();

  if (!encodedKey || encodedKey.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
    throw new PrivateAuthUnavailableError();
  }
  const rateLimitKey = Buffer.from(encodedKey, "base64url");
  if (rateLimitKey.length !== 32 || rateLimitKey.toString("base64url") !== encodedKey) {
    throw new PrivateAuthUnavailableError();
  }

  return { origin, rateLimitKey, production };
}

/** Never infer a trusted origin from Host, Forwarded, or X-Forwarded-* headers. */
export function requireAuthMutation(request: NextRequest, config: PrivateAuthConfig): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (request.headers.get("origin") !== config.origin ||
      request.headers.get("x-cr8or-auth") !== "1" ||
      (fetchSite !== null && fetchSite !== "same-origin")) {
    throw new PrivateAuthMutationError();
  }
}

/** Bound the actual stream, including requests with no Content-Length header. */
export async function readUnlockBody(request: NextRequest): Promise<{ accessCode: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType) ||
      request.headers.has("content-encoding")) {
    throw new PrivateAuthRequestError();
  }

  const lengthHeader = request.headers.get("content-length");
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
  if (lengthHeader !== null &&
      (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(declaredLength) ||
        declaredLength! > MAX_BODY_BYTES)) {
    throw new PrivateAuthRequestError();
  }

  try {
    if (!request.body) throw new PrivateAuthRequestError();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          // Do not await an untrusted stream's cancellation hook.
          void reader.cancel().catch(() => undefined);
          throw new PrivateAuthRequestError();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    if (declaredLength !== null && declaredLength !== size) throw new PrivateAuthRequestError();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(chunks, size));
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !("accessCode" in body) ||
        !isAccessCodeInput(body.accessCode)) {
      throw new PrivateAuthRequestError();
    }
    return { accessCode: body.accessCode };
  } catch {
    // JSON and stream errors can include request material. Never preserve them.
    throw new PrivateAuthRequestError();
  }
}

function sessionCookieOptions(config: PrivateAuthConfig) {
  const secure = config.production || config.origin.startsWith("https://");
  return {
    name: secure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME,
    secure,
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
  };
}

/** Read only this deployment's cookie; duplicate names fail closed. */
export function readSessionToken(request: NextRequest, config: PrivateAuthConfig): string | null {
  const { name } = sessionCookieOptions(config);
  let token: string | null = null;
  let matches = 0;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const cookie = part.trim();
    const separator = cookie.indexOf("=");
    const cookieName = separator === -1 ? cookie : cookie.slice(0, separator).trim();
    if (cookieName !== name) continue;
    matches += 1;
    if (matches > 1) return null;
    // Opaque tokens have no percent escapes; the session store validates format.
    token = separator === -1 ? null : cookie.slice(separator + 1);
  }
  return token || null;
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date,
  config: PrivateAuthConfig,
): void {
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set({ ...sessionCookieOptions(config), value: token, expires: expiresAt });
}

export function clearSessionCookie(response: NextResponse, config: PrivateAuthConfig): void {
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set({
    ...sessionCookieOptions(config), value: "", expires: new Date(0), maxAge: 0,
  });
}

export function authJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const AUTH_ERRORS = {
  400: { code: "INVALID_REQUEST", message: "Invalid authentication request." },
  401: { code: "UNAUTHORIZED", message: "Authentication required." },
  429: { code: "RATE_LIMITED", message: "Too many authentication attempts. Try again later." },
  503: { code: "SERVICE_UNAVAILABLE", message: "Authentication is unavailable." },
  405: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
} as const;

/** Callers may supply a static public message, never an underlying error message. */
export function authError(
  status: keyof typeof AUTH_ERRORS,
  message: string = AUTH_ERRORS[status].message,
  retryAfter?: number,
): NextResponse {
  const response = authJson({
    ok: false,
    message,
    error: { code: AUTH_ERRORS[status].code, message },
  }, status);
  if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0) {
    response.headers.set("Retry-After", String(Math.ceil(retryAfter)));
  }
  return response;
}
