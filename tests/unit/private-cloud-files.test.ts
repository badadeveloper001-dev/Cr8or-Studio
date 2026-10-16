import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Process } from "@daytona/sdk";
import { PRIVATE_CLOUD_FILE_LIMITS, privateCloudFileOperation } from "@/lib/workspace/private-cloud-files";

const execute = promisify(exec);
let root: string;
let processAdapter: Pick<Process, "executeCommand">;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-cloud-files-"));
  await fs.mkdir(path.join(root, "repo"));
  await fs.mkdir(path.join(root, "outside"));
  await fs.writeFile(path.join(root, "outside", "secret.txt"), "outside secret");
  processAdapter = { executeCommand: vi.fn(async (command: string) => {
    try {
      const result = await execute(command, {
        cwd: root, timeout: 5000,
        // The adapter must not supply a smaller output limit than the helper.
        maxBuffer: PRIVATE_CLOUD_FILE_LIMITS.outputBytes + 1024 * 1024,
      });
      return { result: result.stdout, exitCode: 0 };
    } catch (error) {
      return { result: (error as { stdout?: string }).stdout ?? "", exitCode: 1 };
    }
  }) } as unknown as Pick<Process, "executeCommand">;
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

describe("actual contained cloud filesystem helper", () => {
  it("reads exact UTF-8 contents and lists with real descriptor-relative Python calls", async () => {
    const content = "hello 🌍\r\n\t\0e\u0301\n";
    await fs.mkdir(path.join(root, "repo", "nested"));
    await fs.writeFile(path.join(root, "repo", "nested", "file.txt"), content);
    await expect(privateCloudFileOperation(processAdapter, "read", "nested/file.txt")).resolves.toEqual({
      bytes: Buffer.byteLength(content, "utf8"), content,
    });
    await expect(privateCloudFileOperation(processAdapter, "list", "nested")).resolves.toEqual([{ name: "file.txt", type: "file" }]);
    for (const [command] of vi.mocked(processAdapter.executeCommand).mock.calls) {
      expect(command).not.toContain(content);
      expect(command).not.toContain(Buffer.from(content).toString("base64"));
    }
  });

  it("keeps command syntax in filenames inert", async () => {
    const name = "$(touch injected)'quoted.txt";
    const content = "$(touch injected); `touch injected` ' \"\n";
    await fs.writeFile(path.join(root, "repo", name), content);
    await expect(privateCloudFileOperation(processAdapter, "read", name)).resolves.toMatchObject({ content });
    await expect(fs.stat(path.join(root, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
    const command = vi.mocked(processAdapter.executeCommand).mock.calls[0][0];
    expect(command).not.toContain(content);
    expect(command).not.toContain(Buffer.from(content).toString("base64"));
  });

  it.each(["", "private source 🌍\r\n", "$(touch injected); `touch injected`\n"])("blocks private writes before transporting any contents (%j)", async (content) => {
    await fs.writeFile(path.join(root, "repo", "existing.txt"), "original");
    await expect(privateCloudFileOperation(processAdapter, "write", "existing.txt", content)).rejects.toMatchObject({ status: 503 });
    expect(processAdapter.executeCommand).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(root, "repo", "existing.txt"), "utf8")).resolves.toBe("original");
  });

  it.each(["ancestor", "leaf", "root"])("rejects %s symlinks without modifying or exposing outside files", async (kind) => {
    let target = "linked/secret.txt";
    if (kind === "ancestor") await fs.symlink(path.join(root, "outside"), path.join(root, "repo", "linked"), "dir");
    if (kind === "leaf") {
      target = "linked.txt";
      await fs.symlink(path.join(root, "outside", "secret.txt"), path.join(root, "repo", target));
    }
    if (kind === "root") {
      await fs.rm(path.join(root, "repo"), { recursive: true });
      await fs.symlink(path.join(root, "outside"), path.join(root, "repo"), "dir");
      target = "secret.txt";
    }
    await expect(privateCloudFileOperation(processAdapter, "read", target)).rejects.toMatchObject({ status: 503 });
    const readCalls = vi.mocked(processAdapter.executeCommand).mock.calls.length;
    await expect(privateCloudFileOperation(processAdapter, "write", target, "overwritten")).rejects.toMatchObject({ status: 503 });
    expect(processAdapter.executeCommand).toHaveBeenCalledTimes(readCalls);
    await expect(fs.readFile(path.join(root, "outside", "secret.txt"), "utf8")).resolves.toBe("outside secret");
  });

  it("rejects hard-linked files before reading or truncating them", async () => {
    await fs.link(path.join(root, "outside", "secret.txt"), path.join(root, "repo", "linked.txt"));
    await expect(privateCloudFileOperation(processAdapter, "read", "linked.txt")).rejects.toMatchObject({ status: 503 });
    await expect(privateCloudFileOperation(processAdapter, "write", "linked.txt", "no")).rejects.toMatchObject({ status: 503 });
    await expect(fs.readFile(path.join(root, "outside", "secret.txt"), "utf8")).resolves.toBe("outside secret");
  });

  it.each(["../outside/secret.txt", "/etc/passwd", ".git/config", "nested/.env.production"])("rejects unsafe path %s before any process execution", async (target) => {
    await expect(privateCloudFileOperation(processAdapter, "read", target)).rejects.toThrow();
    expect(processAdapter.executeCommand).not.toHaveBeenCalled();
  });

  it("rejects FIFO reads without blocking or exposing special files", async () => {
    await execute("mkfifo repo/pipe", { cwd: root });
    await expect(privateCloudFileOperation(processAdapter, "read", "pipe")).rejects.toMatchObject({ status: 503 });
  });

  it("omits linked and special files from otherwise compatible directory listings", async () => {
    await fs.writeFile(path.join(root, "repo", "visible.txt"), "ok");
    await fs.symlink(path.join(root, "outside"), path.join(root, "repo", "linked-directory"), "dir");
    await fs.link(path.join(root, "outside", "secret.txt"), path.join(root, "repo", "linked.txt"));
    await execute("mkfifo repo/pipe", { cwd: root });
    await expect(privateCloudFileOperation(processAdapter, "list", ".")).resolves.toEqual([{ name: "visible.txt", type: "file" }]);
  });

  it("rejects invalid UTF-8 without silently replacing source bytes", async () => {
    await fs.writeFile(path.join(root, "repo", "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await expect(privateCloudFileOperation(processAdapter, "read", "invalid.txt")).rejects.toMatchObject({ status: 503 });
  });

  it("reads a file at the byte limit without truncation", async () => {
    const content = "🌍".repeat(PRIVATE_CLOUD_FILE_LIMITS.readBytes / 4);
    await fs.writeFile(path.join(root, "repo", "limit.txt"), content);
    await expect(privateCloudFileOperation(processAdapter, "read", "limit.txt")).resolves.toEqual({
      content, bytes: PRIVATE_CLOUD_FILE_LIMITS.readBytes,
    });
  });

  it("rejects an oversized file rather than returning a prefix or changing it", async () => {
    const content = "s".repeat(PRIVATE_CLOUD_FILE_LIMITS.readBytes + 1);
    await fs.writeFile(path.join(root, "repo", "large.txt"), content);
    await expect(privateCloudFileOperation(processAdapter, "read", "large.txt")).rejects.toMatchObject({ status: 409 });
    await expect(fs.readFile(path.join(root, "repo", "large.txt"), "utf8")).resolves.toBe(content);
  });

  it.each([
    "a".repeat(PRIVATE_CLOUD_FILE_LIMITS.writeBytes + 1),
    "🌍".repeat(PRIVATE_CLOUD_FILE_LIMITS.writeBytes / 4 + 1),
  ])("rejects oversized UTF-8 writes before provider dispatch", async (content) => {
    await expect(privateCloudFileOperation(processAdapter, "write", "file.txt", content)).rejects.toMatchObject({ status: 409 });
    expect(processAdapter.executeCommand).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "repo", "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds command metadata before dispatch", async () => {
    await expect(privateCloudFileOperation(processAdapter, "read", "a".repeat(PRIVATE_CLOUD_FILE_LIMITS.pathBytes + 1))).rejects.toMatchObject({ status: 409 });
    expect(processAdapter.executeCommand).not.toHaveBeenCalled();
  });

  it("returns complete lists at the visible-entry limit and rejects overflowing lists", async () => {
    await Promise.all(Array.from({ length: PRIVATE_CLOUD_FILE_LIMITS.listEntries }, (_, index) =>
      fs.writeFile(path.join(root, "repo", `file-${index}.txt`), "")));
    await expect(privateCloudFileOperation(processAdapter, "list", ".")).resolves.toHaveLength(PRIVATE_CLOUD_FILE_LIMITS.listEntries);
    await fs.writeFile(path.join(root, "repo", "one-too-many.txt"), "");
    await expect(privateCloudFileOperation(processAdapter, "list", ".")).rejects.toMatchObject({ status: 409 });
  });

  it("bounds directory scanning even when every entry is hidden", async () => {
    await Promise.all(Array.from({ length: PRIVATE_CLOUD_FILE_LIMITS.directoryEntries + 1 }, (_, index) =>
      fs.writeFile(path.join(root, "repo", `.hidden-${index}`), "")));
    await expect(privateCloudFileOperation(processAdapter, "list", ".")).rejects.toMatchObject({ status: 409 });
  });

  it("fails closed if Python or the required descriptor APIs are unavailable", async () => {
    vi.mocked(processAdapter.executeCommand).mockResolvedValue({ result: "python3: not found", exitCode: 127 });
    await expect(privateCloudFileOperation(processAdapter, "read", "file.txt")).rejects.toMatchObject({ status: 503 });
  });
});

describe("provider response and duration limits", () => {
  it("passes an explicit remote execution timeout", async () => {
    await fs.writeFile(path.join(root, "repo", "file.txt"), "ok");
    await privateCloudFileOperation(processAdapter, "read", "file.txt");
    expect(processAdapter.executeCommand).toHaveBeenCalledWith(expect.any(String), undefined, undefined, PRIVATE_CLOUD_FILE_LIMITS.remoteSeconds);
  });

  it("bounds the local wait if the provider does not honor its remote timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(processAdapter.executeCommand).mockImplementation(() => new Promise(() => {}));
    const request = privateCloudFileOperation(processAdapter, "read", "file.txt");
    const rejected = expect(request).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(PRIVATE_CLOUD_FILE_LIMITS.localTimeoutMs);
    await rejected;
  });

  it("rejects oversized remote output before parsing or returning any portion", async () => {
    vi.mocked(processAdapter.executeCommand).mockResolvedValue({
      result: "p".repeat(PRIVATE_CLOUD_FILE_LIMITS.outputBytes + 1), exitCode: 0,
    });
    await expect(privateCloudFileOperation(processAdapter, "read", "file.txt")).rejects.toMatchObject({ status: 409 });
  });

  it("checks every returned output channel before selecting an otherwise valid response", async () => {
    vi.mocked(processAdapter.executeCommand).mockResolvedValue({
      result: "p".repeat(PRIVATE_CLOUD_FILE_LIMITS.outputBytes + 1), exitCode: 0,
      artifacts: { stdout: JSON.stringify({ ok: true, data: { content: "ok", bytes: 2 } }), charts: [] },
    });
    await expect(privateCloudFileOperation(processAdapter, "read", "file.txt")).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    { content: "🌍", bytes: 1 },
    { content: "private", bytes: -1 },
    { content: "private", bytes: "7" },
    { content: 123, bytes: 3 },
    { content: "\ud800", bytes: 3 },
  ])("rejects malformed or inconsistent read results", async (data) => {
    vi.mocked(processAdapter.executeCommand).mockResolvedValue({ result: JSON.stringify({ ok: true, data }), exitCode: 0 });
    await expect(privateCloudFileOperation(processAdapter, "read", "file.txt")).rejects.toMatchObject({ status: 503 });
  });

  it("rejects an oversized read response even if the provider claims a small byte count", async () => {
    vi.mocked(processAdapter.executeCommand).mockResolvedValue({
      result: JSON.stringify({ ok: true, data: { content: "s".repeat(PRIVATE_CLOUD_FILE_LIMITS.readBytes + 1), bytes: 1 } }), exitCode: 0,
    });
    await expect(privateCloudFileOperation(processAdapter, "read", "file.txt")).rejects.toThrow();
  });

  it("returns only the expected file fields rather than arbitrary provider metadata", async () => {
    vi.mocked(processAdapter.executeCommand).mockResolvedValue({
      result: JSON.stringify({ ok: true, data: { content: "ok", bytes: 2, executionDetails: "private provider metadata" } }), exitCode: 0,
    });
    await expect(privateCloudFileOperation(processAdapter, "read", "file.txt")).resolves.toEqual({ content: "ok", bytes: 2 });
    vi.mocked(processAdapter.executeCommand).mockResolvedValue({
      result: JSON.stringify({ ok: true, data: [{ name: "file.txt", type: "file", executionDetails: "private provider metadata" }] }), exitCode: 0,
    });
    await expect(privateCloudFileOperation(processAdapter, "list", ".")).resolves.toEqual([{ name: "file.txt", type: "file" }]);
  });

  it.each(["rejection", "stderr", "malformed-output"])("does not expose provider execution details through %s errors", async (failure) => {
    const secret = "PRIVATE_PROVIDER_CONTENT_do_not_expose";
    const encoded = Buffer.from(secret).toString("base64");
    if (failure === "rejection") vi.mocked(processAdapter.executeCommand).mockRejectedValue(new Error(`${secret} ${encoded}`));
    if (failure === "stderr") vi.mocked(processAdapter.executeCommand).mockResolvedValue({ result: `${secret} ${encoded}`, exitCode: 1 });
    if (failure === "malformed-output") vi.mocked(processAdapter.executeCommand).mockResolvedValue({ result: `${secret} ${encoded}`, exitCode: 0 });
    const failureResult = await privateCloudFileOperation(processAdapter, "read", "file.txt").catch((error: unknown) => error);
    expect(failureResult).toMatchObject({ status: 503 });
    expect(String(failureResult)).not.toContain(secret);
    expect(String(failureResult)).not.toContain(encoded);
  });
});
