import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authError,
  authJson,
  clearSessionCookie,
  PrivateAuthMutationError,
  PrivateAuthRequestError,
  PrivateAuthUnavailableError,
  readPrivateAuthConfig,
  readSessionToken,
  readUnlockBody,
  requireAuthMutation,
  setSessionCookie,
  type PrivateAuthConfig,
} from "@/lib/security/private-auth-http";

const origin = "https://studio.example.test";
const key = Buffer.alloc(32, 7).toString("base64url");
const token = Buffer.alloc(32, 9).toString("base64url");
const config: PrivateAuthConfig = { origin, rateLimitKey: Buffer.from(key, "base64url"), production: true };
const localConfig: PrivateAuthConfig = { ...config, origin: "http://localhost:3000", production: false };

function request(body: BodyInit | null = JSON.stringify({ accessCode: "private-access-code" }), headers: HeadersInit = {}) {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
  return new NextRequest(`${origin}/api/auth/unlock`, {
    method: "POST",
    body,
    headers: requestHeaders,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);
}

beforeEach(() => {
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "true");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", origin);
  vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", key);
  vi.stubEnv("NODE_ENV", "production");
  for (const name of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("private authentication configuration", () => {
  it("reads a canonical HTTPS origin and a decoded 32-byte key", () => {
    expect(readPrivateAuthConfig()).toEqual(config);
  });

  it.each([undefined, "", "false", "TRUE", "1", " true", "true\n"])(
    "requires the explicit true enable flag: %j", (value) => {
      vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", value);
      expect(readPrivateAuthConfig).toThrow(PrivateAuthUnavailableError);
    },
  );

  it.each([
    undefined, "", "not a URL", `${origin}/`, `${origin}/path`, `${origin}?q=1`, `${origin}#fragment`,
    `${origin}?`, `${origin}#`, "https://owner:secret@studio.example.test", "https://studio.example.test:443",
    "HTTPS://studio.example.test", "https://STUDIO.example.test", ` ${origin}`, `${origin}\n`,
    "ftp://studio.example.test", "file:///tmp/auth", "http://studio.example.test", "null",
  ])("rejects a noncanonical or unsafe configured origin: %j", (value) => {
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", value);
    expect(readPrivateAuthConfig).toThrow(PrivateAuthUnavailableError);
  });

  it.each([
    undefined, "", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}B`,
    `${key}=`, `${key}\n`, ` ${key}`, `${key.slice(0, -1)}+`,
  ])("rejects missing or noncanonical key material without exposing it", (value) => {
    vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", value);
    expect(readPrivateAuthConfig).toThrow(new PrivateAuthUnavailableError());
  });

  it.each(["development", "test"])("permits canonical loopback HTTP in %s", (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", `http://${hostname}:3000`);
      expect(readPrivateAuthConfig()).toMatchObject({ origin: `http://${hostname}:3000`, production: false });
    }
  });

  it.each([undefined, "", "production", "staging"])("forbids loopback HTTP in %j", (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", "http://localhost:3000");
    expect(readPrivateAuthConfig).toThrow(PrivateAuthUnavailableError);
  });

  it.each(["127.0.0.2", "localhost.evil.test", "0.0.0.0", "2130706433", "[::ffff:127.0.0.1]"])(
    "forbids other HTTP hosts and loopback aliases: %s", (hostname) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", `http://${hostname}:3000`);
      expect(readPrivateAuthConfig).toThrow(PrivateAuthUnavailableError);
    },
  );

  it.each([
    ["VERCEL", "1"], ["VERCEL_ENV", "preview"], ["VERCEL_ENV", "production"],
    ["VERCEL_URL", "studio.vercel.app"], ["VERCEL_DEPLOYMENT_ID", "deployment-id"],
  ])("requires HTTPS when %s indicates a deployment", (name, value) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv(name, value);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", "http://localhost:3000");
    expect(readPrivateAuthConfig).toThrow(PrivateAuthUnavailableError);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", origin);
    expect(readPrivateAuthConfig().production).toBe(true);
  });

  it("does not cache environment configuration or decoded mutable key buffers", () => {
    readPrivateAuthConfig().rateLimitKey.fill(0);
    expect(readPrivateAuthConfig().rateLimitKey.toString("base64url")).toBe(key);
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "false");
    expect(readPrivateAuthConfig).toThrow(PrivateAuthUnavailableError);
  });
});

describe("authentication mutation origin checks", () => {
  it.each([undefined, "same-origin"])("accepts exact origin and the required custom header", (fetchSite) => {
    const headers: Record<string, string> = { origin, "x-cr8or-auth": "1" };
    if (fetchSite !== undefined) headers["sec-fetch-site"] = fetchSite;
    expect(() => requireAuthMutation(request(null, headers), config)).not.toThrow();
  });

  it.each([
    {}, { origin }, { "x-cr8or-auth": "1" }, { origin, "x-cr8or-auth": "true" },
    { origin: "null", "x-cr8or-auth": "1" }, { origin: `${origin}/`, "x-cr8or-auth": "1" },
    { origin: `${origin}, https://evil.test`, "x-cr8or-auth": "1" },
    { origin: "https://evil.test", "x-cr8or-auth": "1", host: "evil.test", "x-forwarded-host": "evil.test" },
    { origin, "x-cr8or-auth": "1", "sec-fetch-site": "same-site" },
    { origin, "x-cr8or-auth": "1", "sec-fetch-site": "cross-site" },
    { origin, "x-cr8or-auth": "1", "sec-fetch-site": "none" },
    { origin, "x-cr8or-auth": "1", "sec-fetch-site": "" },
  ])("rejects missing, untrusted, or inconsistent browser headers", (headers) => {
    expect(() => requireAuthMutation(request(null, headers as HeadersInit), config))
      .toThrow(PrivateAuthMutationError);
  });
});

describe("bounded unlock request bodies", () => {
  it.each(["application/json", "application/json; charset=utf-8", "Application/JSON; CHARSET=\"UTF-8\""])(
    "accepts JSON with the permitted content type %s", async (contentType) => {
      await expect(readUnlockBody(request(undefined, { "content-type": contentType })))
        .resolves.toEqual({ accessCode: "private-access-code" });
    },
  );

  it.each([
    "", "text/plain", "application/x-www-form-urlencoded", "application/jsonp", "application/problem+json",
    "application/json; charset=utf-16", "application/json; charset=utf-8; q=1", "application/json; charset=utf-8, text/plain",
  ])("rejects unsupported content types %j", async (contentType) => {
    await expect(readUnlockBody(request(undefined, { "content-type": contentType })))
      .rejects.toThrow(PrivateAuthRequestError);
  });

  it.each(["gzip", "br", "identity", ""])("rejects Content-Encoding %j", async (encoding) => {
    await expect(readUnlockBody(request(undefined, { "content-encoding": encoding })))
      .rejects.toThrow(PrivateAuthRequestError);
  });

  it.each([null, "", "not json", "null", "[]", "{}", '{"accessCode":1}', '{"accessCode":null}',
    '{"accessCode":""}', '{"accessCode":"code","extra":true}', '{"accessCode":"code","__proto__":{}}'])
    ("rejects invalid body structure %j", async (body) => {
      await expect(readUnlockBody(request(body))).rejects.toThrow(PrivateAuthRequestError);
    });

  it.each(["-1", "+1", "1.5", "NaN", "1, 1", "4097", "9007199254740992", ""])(
    "rejects invalid or excessive Content-Length %j before reading", async (length) => {
      const stream = new ReadableStream<Uint8Array>();
      await expect(readUnlockBody(request(stream, { "content-length": length })))
        .rejects.toThrow(PrivateAuthRequestError);
      expect(stream.locked).toBe(false);
    },
  );

  it("accepts a correct Content-Length and rejects conflicting actual lengths", async () => {
    const body = JSON.stringify({ accessCode: "valid-code" });
    await expect(readUnlockBody(request(body, { "content-length": String(Buffer.byteLength(body)) })))
      .resolves.toEqual({ accessCode: "valid-code" });
    for (const length of ["0", "1", "4096"]) {
      await expect(readUnlockBody(request(body, { "content-length": length })))
        .rejects.toThrow(PrivateAuthRequestError);
    }
  });

  it("enforces 4096 actual bytes with both absent and falsely small Content-Length", async () => {
    const body = JSON.stringify({ accessCode: "valid-code" });
    const padded = body + " ".repeat(4_096 - Buffer.byteLength(body));
    await expect(readUnlockBody(request(padded))).resolves.toEqual({ accessCode: "valid-code" });
    const headerCases: HeadersInit[] = [{}, { "content-length": "1" }];
    for (const headers of headerCases) {
      await expect(readUnlockBody(request(`${padded} `, headers)))
        .rejects.toThrow(PrivateAuthRequestError);
    }
  });

  it("cancels a growing stream at the limit without waiting for its cancellation hook", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_096).fill(32));
        controller.enqueue(new Uint8Array(1).fill(32));
      },
      cancel,
    });
    await expect(readUnlockBody(request(stream))).rejects.toThrow(PrivateAuthRequestError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("measures access-code size in UTF-8 bytes and preserves the exact code", async () => {
    const accessCode = "🔑".repeat(256);
    await expect(readUnlockBody(request(JSON.stringify({ accessCode })))).resolves.toEqual({ accessCode });
    await expect(readUnlockBody(request(JSON.stringify({ accessCode: `${accessCode}x` }))))
      .rejects.toThrow(PrivateAuthRequestError);
    await expect(readUnlockBody(request(JSON.stringify({ accessCode: " exact code " }))))
      .resolves.toEqual({ accessCode: " exact code " });
  });

  it("rejects invalid UTF-8 instead of silently replacing credential bytes", async () => {
    const invalid = Buffer.concat([
      Buffer.from('{"accessCode":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}'),
    ]);
    await expect(readUnlockBody(request(invalid))).rejects.toThrow(PrivateAuthRequestError);
  });

  it.each(["\ud800", "\udfff", "\udc00\ud800", "\ud800X", "\ud800😀"])(
    "rejects JSON escapes containing unpaired UTF-16 surrogates (case %#)", async (suffix) => {
      const body = JSON.stringify({ accessCode: `synthetic-access-code${suffix}` });
      await expect(readUnlockBody(request(body))).rejects.toThrow(PrivateAuthRequestError);
    },
  );

  it("accepts JSON-escaped surrogate pairs and literal replacement characters unchanged", async () => {
    const body = String.raw`{"accessCode":"synthetic-\ud800\udc00\udbff\udfff\ufffd"}`;
    await expect(readUnlockBody(request(body)))
      .resolves.toEqual({ accessCode: "synthetic-\ud800\udc00\udbff\udfff\ufffd" });
  });

  it("handles UTF-8 characters split across chunks", async () => {
    const body = Buffer.from(JSON.stringify({ accessCode: "é" }));
    const split = body.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, split));
        controller.enqueue(body.subarray(split));
        controller.close();
      },
    });
    await expect(readUnlockBody(request(stream))).resolves.toEqual({ accessCode: "é" });
  });

  it("sanitizes parser and stream failures without logging request material", async () => {
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("private-access-code")); },
    });
    for (const body of ['{"accessCode":"private-access-code"', stream]) {
      await expect(readUnlockBody(request(body))).rejects.toEqual(new PrivateAuthRequestError());
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(new PrivateAuthRequestError()).not.toHaveProperty("cause");
  });
});

describe("private authentication cookies", () => {
  const expiresAt = new Date("2030-01-01T12:00:00.000Z");

  it.each([config, { ...config, production: false }])("uses a secure host-only cookie for HTTPS", (cookieConfig) => {
    const response = NextResponse.json({ ok: true });
    setSessionCookie(response, token, expiresAt, cookieConfig);
    expect(response.cookies.get("__Host-cr8or-session")).toEqual({
      name: "__Host-cr8or-session", value: token, expires: expiresAt,
      secure: true, httpOnly: true, sameSite: "strict", path: "/",
    });
    const header = response.headers.get("set-cookie")!;
    expect(header).not.toMatch(/domain=|max-age=/i);
    expect(header).toContain("Expires=Tue, 01 Jan 2030 12:00:00 GMT");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses the separate nonsecure cookie only for the configured local HTTP case", () => {
    const response = authJson({ ok: true });
    setSessionCookie(response, token, expiresAt, localConfig);
    expect(response.cookies.get("cr8or-dev-session")).toMatchObject({ secure: false, httpOnly: true, sameSite: "strict" });
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
    expect(response.cookies.has("__Host-cr8or-session")).toBe(false);
  });

  it.each([
    [config, "__Host-cr8or-session", "cr8or-dev-session"],
    [localConfig, "cr8or-dev-session", "__Host-cr8or-session"],
  ] as const)("reads only the configured cookie name", (cookieConfig, name, otherName) => {
    const input = request(null, { cookie: `${otherName}=ignored; ${name}=${token}` });
    expect(readSessionToken(input, cookieConfig)).toBe(token);
    expect(readSessionToken(request(null, { cookie: `${otherName}=${token}`, authorization: `Bearer ${token}` }), cookieConfig))
      .toBeNull();
  });

  it.each([
    "", "other=irrelevant", "__Host-cr8or-session=", "__Host-cr8or-session",
    `__Host-cr8or-session=${token}; __Host-cr8or-session=${token}`,
    `__Host-cr8or-session=; __Host-cr8or-session=${token}`,
  ])("rejects missing, empty, or duplicate configured cookies", (cookie) => {
    expect(readSessionToken(request(null, { cookie }), config)).toBeNull();
  });

  it("passes malformed opaque values unchanged to session-store validation", () => {
    expect(readSessionToken(request(null, { cookie: "__Host-cr8or-session=%41malformed" }), config)).toBe("%41malformed");
  });

  it.each([config, localConfig])("clears the same cookie with the same security attributes", (cookieConfig) => {
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response, cookieConfig);
    const name = cookieConfig === config ? "__Host-cr8or-session" : "cr8or-dev-session";
    expect(response.cookies.get(name)).toMatchObject({
      name, value: "", maxAge: 0, secure: cookieConfig === config, httpOnly: true, sameSite: "strict", path: "/",
    });
    expect(response.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(response.headers.get("set-cookie")).not.toMatch(/domain=/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("private authentication JSON responses", () => {
  it("marks success responses no-store", async () => {
    const response = authJson({ ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it.each([
    [400, "INVALID_REQUEST"], [401, "UNAUTHORIZED"], [429, "RATE_LIMITED"],
    [503, "SERVICE_UNAVAILABLE"], [405, "METHOD_NOT_ALLOWED"],
  ] as const)("returns the safe existing error envelope and no-store for %i", async (status, code) => {
    const response = authError(status);
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ ok: false, message: expect.any(String), error: { code, message: body.message } });
    expect(response.headers.has("retry-after")).toBe(false);
  });

  it("emits whole-second Retry-After and a static public message", async () => {
    const response = authError(429, "Try again later.", 4.2);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ message: "Try again later." });
  });

  it.each([0, -1, NaN, Infinity])("does not serialize invalid Retry-After %s", (retryAfter) => {
    expect(authError(429, undefined, retryAfter).headers.has("retry-after")).toBe(false);
  });
});
