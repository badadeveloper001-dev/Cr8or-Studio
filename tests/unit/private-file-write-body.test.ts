import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveOwnerSession: vi.fn(), authorizedRuntime: vi.fn(), writeFile: vi.fn(), policy: vi.fn() }));
vi.mock("@/lib/security/session-store", () => ({ resolveOwnerSession: mocks.resolveOwnerSession, resolveSessionById: vi.fn() }));
vi.mock("@/lib/workspace/authorized-runtime", () => ({ authorizedRuntime: mocks.authorizedRuntime }));
vi.mock("@/lib/security/policy", () => ({ evaluatePolicyGuard: mocks.policy }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseClient: vi.fn() }));

import { POST } from "@/app/api/files/route";
import { PRIVATE_FILE_WRITE_BODY_LIMITS } from "@/lib/security/private-file-write-body";

const origin = "https://studio.example.test";
const token = Buffer.alloc(32, 6).toString("base64url");
const payload = { projectId: "registered-project", path: "source.ts", content: "  café 🚀\r\n\tconst value = '\\n';\n" };

function request(body: BodyInit | null, overrides: HeadersInit = {}, signal?: AbortSignal) {
  const headers = new Headers({ origin, "content-type": "application/json", "x-cr8or-auth": "1", cookie: `__Host-cr8or-session=${token}` });
  new Headers(overrides).forEach((value, key) => headers.set(key, value));
  return new NextRequest(`${origin}/api/files`, { method: "POST", body, headers, signal, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
}

function chunks(values: Uint8Array[], cancel?: () => Promise<void> | void) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      if (!cancel) controller.close();
    }, cancel,
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "true");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", origin);
  vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", Buffer.alloc(32, 7).toString("base64url"));
  vi.stubEnv("CR8OR_FEATURE_AUDIT_LOG", "false");
  vi.stubEnv("CR8OR_FEATURE_AUTH_GUARD", "false");
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) vi.stubEnv(key, undefined);
  mocks.resolveOwnerSession.mockResolvedValue({ id: "server-session", ownerId: "owner", credentialVersion: 1 });
  mocks.authorizedRuntime.mockResolvedValue({ ok: true, session: { userId: "owner", role: "owner" }, runtime: { writeFile: mocks.writeFile } });
  mocks.writeFile.mockResolvedValue({ bytes: Buffer.byteLength(payload.content) });
  mocks.policy.mockReturnValue({ allowed: true });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("private file-write request boundary", () => {
  it("preserves exact valid source contents and does not use the unbounded JSON reader", async () => {
    const body = JSON.stringify(payload);
    const input = request(body, { "content-length": String(Buffer.byteLength(body)) });
    const json = vi.spyOn(input, "json");
    const response = await POST(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).not.toHaveBeenCalled();
    expect(mocks.authorizedRuntime).toHaveBeenCalledExactlyOnceWith(input, payload.projectId, true);
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith(payload.path, payload.content);
  });

  it("decodes exact UTF-8 contents when a multibyte character spans stream chunks", async () => {
    const body = Buffer.from(JSON.stringify(payload));
    const split = body.indexOf(0xc3) + 1;
    const response = await POST(request(chunks([body.subarray(0, split), body.subarray(split)])));
    expect(response.status).toBe(200);
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith(payload.path, payload.content);
  });

  it("accepts a valid request after many empty chunks without accumulating payload fragments", async () => {
    let emptyChunks = 50_000;
    const body = Buffer.from(JSON.stringify(payload));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emptyChunks-- > 0) controller.enqueue(new Uint8Array(0));
        else { controller.enqueue(body); controller.close(); }
      },
    });
    expect((await POST(request(stream))).status).toBe(200);
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith(payload.path, payload.content);
  });

  it("preserves exact source contents through tens of thousands of one-byte chunks", async () => {
    const fragmented = { ...payload, content: payload.content.repeat(1_024) };
    const body = Buffer.from(JSON.stringify(fragmented));
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < body.length) controller.enqueue(body.subarray(offset, ++offset));
        else controller.close();
      },
    });
    expect((await POST(request(stream))).status).toBe(200);
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith(payload.path, fragmented.content);
  });

  it("cancels continuously available empty chunks at the monotonic deadline even if timers cannot run", async () => {
    let now = 0;
    let reads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        now += PRIVATE_FILE_WRITE_BODY_LIMITS.timeoutMs / 4;
        controller.enqueue(new Uint8Array(0));
      }, cancel,
    });
    expect((await POST(request(stream))).status).toBe(400);
    expect(reads).toBeLessThanOrEqual(6);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("cancels immediately available chunks when the request aborts during the read loop", async () => {
    const abort = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 32) abort.abort();
        controller.enqueue(new Uint8Array(0));
      }, cancel,
    });
    expect((await POST(request(stream, {}, abort.signal))).status).toBe(400);
    expect(reads).toBeLessThanOrEqual(33);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body before obtaining a stream reader", async () => {
    const input = request(new ReadableStream<Uint8Array>(), { "content-length": String(PRIVATE_FILE_WRITE_BODY_LIMITS.bytes + 1) });
    const reader = vi.spyOn(input.body!, "getReader");
    expect((await POST(input)).status).toBe(413);
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.authorizedRuntime).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it.each([{}, { "content-length": "1" }, { "transfer-encoding": "chunked" }] as HeadersInit[])("limits actual streamed bytes despite headers %j", async (headers) => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const input = request(chunks([new Uint8Array(PRIVATE_FILE_WRITE_BODY_LIMITS.bytes).fill(32), new Uint8Array([32])], cancel), headers);
    expect((await POST(input)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.authorizedRuntime).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("accepts a valid body exactly at the byte limit without truncation", async () => {
    const body = JSON.stringify(payload);
    const padded = body + " ".repeat(PRIVATE_FILE_WRITE_BODY_LIMITS.bytes - Buffer.byteLength(body));
    expect((await POST(request(padded))).status).toBe(200);
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith(payload.path, payload.content);
  });

  it("stops a stalled request after the fixed read deadline without waiting for cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const input = request(new ReadableStream<Uint8Array>({ cancel }));
    const reader = vi.spyOn(input.body!, "getReader");
    const pending = POST(input);
    for (let turn = 0; turn < 20 && !reader.mock.calls.length; turn++) await Promise.resolve();
    expect(reader).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PRIVATE_FILE_WRITE_BODY_LIMITS.timeoutMs);
    expect((await pending).status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("stops reading when the initiating request is aborted", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const input = request(new ReadableStream<Uint8Array>({ cancel }), {}, controller.signal);
    const reader = vi.spyOn(input.body!, "getReader");
    const pending = POST(input);
    for (let turn = 0; turn < 20 && !reader.mock.calls.length; turn++) await Promise.resolve();
    expect(reader).toHaveBeenCalledOnce();
    controller.abort();
    expect((await pending).status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 instead of replacing source characters", async () => {
    const body = Buffer.concat([Buffer.from('{"path":"source.ts","content":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it.each(["-1", "NaN", "1.5", "1, 1", "9007199254740992"])("rejects malformed content length %j", async (length) => {
    expect((await POST(request(JSON.stringify(payload), { "content-length": length }))).status).toBe(400);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a declared length that differs from the complete body", async () => {
    expect((await POST(request(JSON.stringify(payload), { "content-length": "1" }))).status).toBe(400);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("does not expose submitted contents in parser or stream error responses or logs", async () => {
    const privateText = "synthetic-private-source-for-error-test";
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(privateText)); } });
    for (const body of [`{"content":"${privateText}"`, broken]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(privateText);
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("authenticates before accessing a request body even when its declared length is excessive", async () => {
    const input = request(new ReadableStream<Uint8Array>(), { cookie: "", "content-length": String(PRIVATE_FILE_WRITE_BODY_LIMITS.bytes + 1) });
    const reader = vi.spyOn(input.body!, "getReader");
    expect((await POST(input)).status).toBe(401);
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.authorizedRuntime).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("checks the existing mutation origin before reading the body", async () => {
    const input = request(new ReadableStream<Uint8Array>(), { origin: "https://untrusted.example.test" });
    const reader = vi.spyOn(input.body!, "getReader");
    expect((await POST(input)).status).toBe(400);
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.authorizedRuntime).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("retains the existing JSON reader in inactive staging mode", async () => {
    for (const name of ["CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY"]) vi.stubEnv(name, undefined);
    const input = request(JSON.stringify(payload));
    const json = vi.spyOn(input, "json");
    expect((await POST(input)).status).toBe(200);
    expect(json).toHaveBeenCalledOnce();
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith(payload.path, payload.content);
  });
});
