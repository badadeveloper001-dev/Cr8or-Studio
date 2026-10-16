import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Process } from "@daytona/sdk";
import { privateCloudFileOperation } from "@/lib/workspace/private-cloud-files";

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
      const result = await execute(command, { cwd: root, timeout: 5000 });
      return { result: result.stdout, exitCode: 0 };
    } catch (error) {
      return { result: (error as { stdout?: string }).stdout ?? "", exitCode: 1 };
    }
  }) } as unknown as Pick<Process, "executeCommand">;
});

afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("actual contained cloud filesystem helper", () => {
  it("writes, reads, and lists using real descriptor-relative Python filesystem calls", async () => {
    await expect(privateCloudFileOperation(processAdapter, "write", "nested/file.txt", "hello 🌍")).resolves.toEqual({ bytes: 10 });
    await expect(privateCloudFileOperation(processAdapter, "read", "nested/file.txt")).resolves.toEqual({ bytes: 10, content: "hello 🌍" });
    await expect(privateCloudFileOperation(processAdapter, "list", "nested")).resolves.toEqual([{ name: "file.txt", type: "file" }]);
  });

  it("keeps command syntax in filenames and contents as inert data", async () => {
    const name = "$(touch injected)'quoted.txt";
    const content = "$(touch injected); `touch injected` ' \"\n";
    await privateCloudFileOperation(processAdapter, "write", name, content);
    await expect(privateCloudFileOperation(processAdapter, "read", name)).resolves.toMatchObject({ content });
    await expect(fs.stat(path.join(root, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(privateCloudFileOperation(processAdapter, "write", target, "overwritten")).rejects.toMatchObject({ status: 503 });
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

  it("fails closed if Python or the required descriptor APIs are unavailable", async () => {
    vi.mocked(processAdapter.executeCommand).mockResolvedValue({ result: "python3: not found", exitCode: 127 });
    await expect(privateCloudFileOperation(processAdapter, "read", "file.txt")).rejects.toMatchObject({ status: 503 });
  });
});
