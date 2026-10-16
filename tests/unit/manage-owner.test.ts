import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { main, readAccessCodeFromStdin, readHiddenLine } from "../../scripts/manage-owner.mjs";

const accessCode = "  synthetic CLI test access code  ";
const metadata = { credentialVersion: 2, createdAt: "2030-01-01", updatedAt: "2030-01-02" };

function harness(argv: string[], source = JSON.stringify({ accessCode })) {
  let stdout = "";
  let stderr = "";
  const services = {
    provisionOwner: vi.fn().mockResolvedValue(metadata),
    rotateOwnerAccessCode: vi.fn().mockResolvedValue({ ...metadata, revokedCount: 3 }),
    revokeAllOwnerSessions: vi.fn().mockResolvedValue({ credentialVersion: 3, revokedCount: 4 }),
    inspectOwnerStatus: vi.fn().mockResolvedValue({
      provisioned: true, ...metadata, sessions: { total: 3, active: 0, revoked: 3, expired: 1 },
      accessCodeHash: "never-print-hash", webAuthnUserHandle: "never-print-handle",
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const loadServices = vi.fn().mockResolvedValue(services);
  const options = {
    argv,
    input: Readable.from([Buffer.from(source)]) as typeof process.stdin,
    output: new Writable({ write(chunk, _encoding, done) { stdout += chunk.toString(); done(); } }) as typeof process.stdout,
    errorOutput: new Writable({ write(chunk, _encoding, done) { stderr += chunk.toString(); done(); } }) as typeof process.stderr,
    env: { DATABASE_URL: "synthetic-only-no-connection", NODE_ENV: "test" as const },
    loadServices,
  };
  return { options, services, loadServices, stdout: () => stdout, stderr: () => stderr };
}

class FakeTerminal extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode = vi.fn((enabled: boolean) => { this.isRaw = enabled; return this; });
}

describe("owner operator CLI", () => {
  it.each(["provision", "rotate"])("passes an exact whitespace-preserving code from --stdin to %s", async (operation) => {
    const h = harness([operation, "--stdin"]);
    expect(await main(h.options)).toBe(0);
    expect(operation === "provision" ? h.services.provisionOwner : h.services.rotateOwnerAccessCode).toHaveBeenCalledWith(accessCode);
    expect(JSON.parse(h.stdout())).toMatchObject({ ok: true, operation, credentialVersion: 2 });
    expect(h.stdout()).not.toContain(accessCode);
    expect(h.stderr()).toBe("");
    expect(h.services.close).toHaveBeenCalledOnce();
  });

  it.each([
    [], ["unknown"], ["provision", "synthetic-secret-argument"],
    ["rotate", "--stdin", "extra"], ["status", "--stdin"], ["revoke-all", "--stdin"],
  ].map((argv) => ({ argv })))("rejects invalid arguments without echoing them or loading storage: $argv", async ({ argv }) => {
    const h = harness(argv);
    expect(await main(h.options)).toBe(2);
    expect(JSON.parse(h.stdout()).error.code).toBe("INVALID_INPUT");
    expect(h.stdout()).not.toContain("synthetic-secret-argument");
    expect(h.loadServices).not.toHaveBeenCalled();
  });

  it("requires explicit --stdin when a terminal is unavailable", async () => {
    const h = harness(["provision"]);
    expect(await main(h.options)).toBe(2);
    expect(JSON.parse(h.stdout()).error.message).toContain("terminal is required");
    expect(h.loadServices).not.toHaveBeenCalled();
  });

  it.each([
    "", "not-json", "[]", '{"accessCode":1}', '{"accessCode":"x","extra":true}',
    '{"accessCode":"first","accessCode":"second"}',
  ])("rejects invalid JSON or extra properties", async (source) => {
    const h = harness(["provision", "--stdin"], source);
    expect(await main(h.options)).toBe(2);
    expect(h.loadServices).not.toHaveBeenCalled();
    expect(h.stdout()).not.toContain(source || "never-present-marker");
  });

  it("bounds input before parsing and rejects invalid UTF-8", async () => {
    await expect(readAccessCodeFromStdin(Readable.from([Buffer.alloc(16_385, 32)]))).rejects.toThrow("size limit");
    await expect(readAccessCodeFromStdin(Readable.from([
      Buffer.from('{"accessCode":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}'),
    ]))).rejects.toThrow("valid UTF-8");
  });

  it("preserves escaped newlines and UTF-8 split across chunks", async () => {
    const value = "  😀 synthetic\nUnicode code  ";
    const bytes = Buffer.from(JSON.stringify({ accessCode: value }));
    const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
    expect(await readAccessCodeFromStdin(Readable.from(chunks))).toBe(value);
  });

  it.each(["\ud800", "\udfff", "\udc00\ud800", "\ud800X", "\ud800😀"])(
    "rejects JSON-escaped lone surrogates before loading storage (case %#)", async (suffix) => {
      const source = JSON.stringify({ accessCode: `${accessCode}${suffix}` });
      await expect(readAccessCodeFromStdin(Readable.from([Buffer.from(source)])))
        .rejects.toThrow("valid Unicode");
      const h = harness(["provision", "--stdin"], source);
      expect(await main(h.options)).toBe(2);
      expect(JSON.parse(h.stdout()).error.code).toBe("INVALID_INPUT");
      expect(h.stdout()).not.toContain(accessCode);
      expect(h.loadServices).not.toHaveBeenCalled();
    },
  );

  it("passes JSON-escaped surrogate pairs and replacement characters to storage unchanged", async () => {
    const source = String.raw`{"accessCode":"synthetic access code \ud800\udc00\udbff\udfff\ufffd"}`;
    const h = harness(["provision", "--stdin"], source);
    expect(await main(h.options)).toBe(0);
    expect(h.services.provisionOwner).toHaveBeenCalledWith("synthetic access code \ud800\udc00\udbff\udfff\ufffd");
  });

  it.each(["short", "😀".repeat(15), "x".repeat(1_025)])("rejects codes outside the length policy before storage", async (value) => {
    const h = harness(["rotate", "--stdin"], JSON.stringify({ accessCode: value }));
    expect(await main(h.options)).toBe(2);
    expect(h.loadServices).not.toHaveBeenCalled();
  });

  it("returns only safe status fields and never requests input", async () => {
    const h = harness(["status"]);
    expect(await main(h.options)).toBe(0);
    expect(h.services.inspectOwnerStatus).toHaveBeenCalledOnce();
    expect(JSON.parse(h.stdout())).toEqual({
      ok: true, operation: "status", provisioned: true, ...metadata,
      sessions: { total: 3, active: 0, revoked: 3, expired: 1 },
    });
    expect(h.stderr()).toBe("");
  });

  it("runs revoke-all without asking for an access code", async () => {
    const h = harness(["revoke-all"]);
    expect(await main(h.options)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({ ok: true, operation: "revoke-all", credentialVersion: 3, revokedCount: 4 });
  });

  it("requires trusted database configuration, except for help", async () => {
    const h = harness(["status"]);
    h.options.env.DATABASE_URL = "";
    expect(await main(h.options)).toBe(2);
    expect(h.loadServices).not.toHaveBeenCalled();
    const help = harness(["--help"]);
    help.options.env.DATABASE_URL = "";
    expect(await main(help.options)).toBe(0);
    expect(help.stdout()).toContain("Usage:");
    expect(help.loadServices).not.toHaveBeenCalled();
  });

  it("sanitizes storage failures and disconnects after a failed operation", async () => {
    const h = harness(["rotate", "--stdin"]);
    h.services.rotateOwnerAccessCode.mockRejectedValue(new Error("private URL and synthetic-secret-hash"));
    expect(await main(h.options)).toBe(1);
    expect(JSON.parse(h.stdout()).error.code).toBe("UNAVAILABLE");
    expect(h.stdout()).not.toContain("synthetic-secret-hash");
    expect(h.stdout()).not.toContain(accessCode);
    expect(h.services.close).toHaveBeenCalledOnce();
  });

  it("does not report a committed mutation as failed when disconnect fails", async () => {
    const h = harness(["rotate", "--stdin"]);
    h.services.close.mockRejectedValue(new Error("private connection cleanup details"));
    expect(await main(h.options)).toBe(0);
    expect(JSON.parse(h.stdout()).ok).toBe(true);
    expect(h.stdout()).not.toContain("private");
  });

  it("hides terminal input, handles Unicode backspace, and restores terminal mode", async () => {
    const terminal = new FakeTerminal();
    terminal.pause();
    const signals = new EventEmitter();
    let printed = "";
    const result = readHiddenLine(terminal, { write: (text: string) => { printed += text; } }, "Hidden: ", signals);
    terminal.write(Buffer.from("  synthetic 😀\u007fcode  \r"));
    await expect(result).resolves.toBe("  synthetic code  ");
    expect(printed).toBe("Hidden: \n");
    expect(terminal.isRaw).toBe(false);
    expect(terminal.isPaused()).toBe(true);
    expect(terminal.listenerCount("data")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"])("restores raw mode on %s", async (signal) => {
    const terminal = new FakeTerminal();
    const signals = new EventEmitter();
    const result = readHiddenLine(terminal, { write: vi.fn() }, "Hidden: ", signals);
    signals.emit(signal);
    await expect(result).rejects.toMatchObject({ code: "INTERRUPTED" });
    expect(terminal.isRaw).toBe(false);
    expect(terminal.listenerCount("data")).toBe(0);
  });

  it("preserves a leading Unicode byte-order mark and pauses an initially idle terminal", async () => {
    const terminal = new FakeTerminal();
    const result = readHiddenLine(terminal, { write: vi.fn() }, "Hidden: ", new EventEmitter());
    terminal.write(Buffer.from("\ufeffsynthetic code\r"));
    await expect(result).resolves.toBe("\ufeffsynthetic code");
    expect(terminal.isPaused()).toBe(true);
  });

  it("restores terminal mode after Ctrl-C or an overlong code", async () => {
    for (const value of ["\u0003", "x".repeat(1_025)]) {
      const terminal = new FakeTerminal();
      const result = readHiddenLine(terminal, { write: vi.fn() }, "Hidden: ", new EventEmitter());
      terminal.write(Buffer.from(value));
      await expect(result).rejects.toThrow();
      expect(terminal.isRaw).toBe(false);
    }
  });

  it("requires matching hidden confirmation before loading services", async () => {
    const h = harness(["provision"]);
    const terminal = new FakeTerminal();
    h.options.input = terminal as unknown as typeof process.stdin;
    h.options.errorOutput = new Writable({
      write(chunk, _encoding, done) {
        const prompt = chunk.toString();
        if (prompt.includes("Confirm")) queueMicrotask(() => terminal.write("different synthetic code\r"));
        else if (prompt.includes("Access code")) queueMicrotask(() => terminal.write(`${accessCode}\r`));
        done();
      },
    }) as typeof process.stderr;
    expect(await main(h.options)).toBe(2);
    expect(JSON.parse(h.stdout()).error.message).toContain("did not match");
    expect(h.loadServices).not.toHaveBeenCalled();
    expect(terminal.isRaw).toBe(false);
  });
});
