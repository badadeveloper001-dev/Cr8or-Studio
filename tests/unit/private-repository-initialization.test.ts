import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { validateWorkspaceLifecycleScope } from "@/lib/security/workspace-lifecycle-catalogue";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { createPrivateRepositoryInitializationTransport } from "@/lib/workspace/private-repository-initialization";
import { PRIVATE_REPOSITORY_PROGRAM } from "@/lib/workspace/private-repository-program";
import { assertPrivateGitAvailable } from "@/lib/workspace/private-git-availability";
import { assertPrivateCloudCommandAvailable } from "@/lib/workspace/private-cloud-command-availability";
import { assertPrivateCloudWriteTransportAvailable } from "@/lib/workspace/private-cloud-write-availability";
import { assertPrivateRepositoryCloningAvailable, assertWorkspaceLifecycleAvailable } from "@/lib/workspace/private-workspace-lifecycle-availability";
import type { DaytonaProvider } from "@/lib/workspace/providers/daytona";
import { createControlledDaytonaSessionAdapter, type ControlledSessionLogs } from "../helpers/daytona-session-adapter";
import type { SyntheticGitObject } from "../helpers/git-object-github-adapter";
import { createRepositoryGithubAdapter } from "../helpers/repository-github-adapter";

const execute = promisify(execFile);
const repositoryKey = "badadeveloper001-dev/cr8or-studio";
const repositoryUrl = `https://github.com/${repositoryKey}.git`;
const credential = "synthetic_read_only_repository_fixture_credential";
const sandboxId = "synthetic-initialization-daytona";
const binary = Buffer.from([0, 255, 254, 128, 13, 10, 0, 42]);
const unicodePath = "src/你好-🌍.txt";
const unicodeContent = "Private exact UTF-8 source: こんにちは 🌍\n";
let root: string, source: string, destination: string, head: string, operationId: string;
let objects: SyntheticGitObject[], history: string;
let local: ReturnType<typeof createControlledDaytonaSessionAdapter>;
let provider: Pick<DaytonaProvider, "getPrivateGitSessionProcess">;
let logHook: ((logs: ControlledSessionLogs) => void | Promise<void>) | undefined;
let logTransform: ((logs: ControlledSessionLogs) => ControlledSessionLogs) | undefined;

const gitEnvironment = (): NodeJS.ProcessEnv => ({ NODE_ENV: "test", PATH: process.env.PATH, HOME: root,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Synthetic owner",
  GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Synthetic owner",
  GIT_COMMITTER_EMAIL: "test@example.invalid", TZ: "UTC" });
async function gitAt(directory: string, ...args: string[]) {
  return (await execute("git", args, { cwd: directory, env: gitEnvironment(), maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
async function rawObject(directory: string, object: SyntheticGitObject) {
  return (await execute("git", ["cat-file", object.type, object.oid], {
    cwd: directory, env: gitEnvironment(), encoding: "buffer", maxBuffer: 2 * 1024 * 1024,
  })).stdout;
}
async function collectObjects(): Promise<SyntheticGitObject[]> {
  const result: SyntheticGitObject[] = [];
  for (const line of (await gitAt(source, "rev-list", "--objects", head)).split("\n")) {
    const oid = line.split(" ")[0], type = await gitAt(source, "cat-file", "-t", oid) as SyntheticGitObject["type"];
    result.push({ oid, type, contentBase64: (await rawObject(source, { oid, type, contentBase64: "" })).toString("base64") });
  }
  return result;
}
function scope() {
  return validateWorkspaceLifecycleScope({ version: 1, ownerId: "owner", action: "clone", projectId: "synthetic-initialization-project",
    workspaceRecordId: "synthetic-initialization-registration", providerWorkspaceId: null, projectName: "Synthetic source",
    repositoryKey, repositoryUrl, branch: "main", initialization: { version: 1, strategy: "complete-sha1-git-database", expectedHead: head } });
}
function remote(options: Partial<Parameters<typeof createRepositoryGithubAdapter>[0]> = {}) {
  return createRepositoryGithubAdapter({ repositoryKey, branch: "main", head, objects, expectedCredential: credential, ...options });
}
function transport(fixture: ReturnType<typeof remote>, token = () => credential) {
  return createPrivateRepositoryInitializationTransport(provider, token, fixture.fetcher);
}
async function initialized(fixture = remote(), revalidate = async () => undefined, signal = new AbortController().signal) {
  const instance = transport(fixture), approved = scope();
  await instance.prepare(approved, revalidate, signal);
  const evidence = await instance.initialize(approved, operationId, sandboxId, revalidate, signal);
  return { instance, fixture, approved, evidence };
}
async function exists(filename: string) { try { await fs.lstat(filename); return true; } catch { return false; } }

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-repository-initialization-"));
  source = path.join(root, "source"); destination = path.join(root, "sandbox");
  await fs.mkdir(source); await fs.mkdir(destination);
  await gitAt(source, "init", "-b", "main");
  await fs.writeFile(path.join(source, "README.md"), "Original history remains unchanged\n");
  await gitAt(source, "add", "--", "README.md");
  await gitAt(source, "-c", "commit.gpgSign=false", "commit", "-m", "Original fixture root");
  await fs.mkdir(path.join(source, "src"));
  await fs.writeFile(path.join(source, unicodePath), unicodeContent);
  await fs.writeFile(path.join(source, "binary.dat"), binary);
  await fs.writeFile(path.join(source, "empty.txt"), "");
  await fs.writeFile(path.join(source, "fixture.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await gitAt(source, "add", "--", unicodePath, "binary.dat", "empty.txt", "fixture.sh");
  await gitAt(source, "-c", "commit.gpgSign=false", "commit", "-m", "Original fixture content");
  await fs.writeFile(path.join(source, "README.md"), "Latest source history remains unchanged\n");
  await gitAt(source, "add", "--", "README.md");
  await gitAt(source, "-c", "commit.gpgSign=false", "commit", "-m", "Original fixture latest");
  head = await gitAt(source, "rev-parse", "HEAD"); history = await gitAt(source, "rev-list", "HEAD");
  objects = await collectObjects(); operationId = randomUUID(); logHook = undefined; logTransform = undefined;
  local = createControlledDaytonaSessionAdapter(destination, { maximumOutputBytes: 2 * 1024 * 1024,
    onLogs: logs => logHook?.(logs), transformLogs: logs => logTransform?.(logs) ?? logs });
  const owners = new Set([0, (await fs.stat("/usr/bin/git")).uid, (await fs.stat("/")).uid]);
  const program = PRIVATE_REPOSITORY_PROGRAM.replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${[...owners].join(",")},)`);
  const original = local.executeSessionCommand;
  local.executeSessionCommand = async (session, request, timeout) => {
    if (request.command !== `exec python3 -I -S -u -c ${shellQuote(PRIVATE_REPOSITORY_PROGRAM)}`) throw new Error("Unexpected fixture command.");
    // Only the trusted install UID is adapted. The complete fixed helper runs
    // against disposable disk; this is not live Daytona compatibility evidence.
    return original(session, { ...request, command: `exec python3 -I -S -u -c ${shellQuote(program)}` }, timeout);
  };
  provider = { getPrivateGitSessionProcess: vi.fn(async (id: string) => {
    if (id !== sandboxId) throw new ExecutionAuthorizationError(403);
    return local;
  }) } as unknown as Pick<DaytonaProvider, "getPrivateGitSessionProcess">;
});
afterEach(async () => {
  vi.restoreAllMocks(); await local?.dispose();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("server-mediated repository initialization with actual disposable Git repositories", () => {
  it("preserves exact objects, complete history, branch, binary, empty and Unicode contents", async () => {
    const { instance, approved, evidence, fixture } = await initialized();
    expect(evidence).toEqual({ status: "complete", repositoryKey, branch: "main", head, historyVerified: true });
    const repo = path.join(destination, "repo");
    expect(await gitAt(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await gitAt(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await gitAt(repo, "rev-list", "HEAD")).toBe(history);
    expect(await gitAt(repo, "fsck", "--full", "--strict")).toBe("");
    for (const object of objects) expect(await rawObject(repo, object)).toEqual(Buffer.from(object.contentBase64, "base64"));
    expect(await fs.readFile(path.join(repo, "binary.dat"))).toEqual(binary);
    expect(await fs.readFile(path.join(repo, "empty.txt"))).toHaveLength(0);
    expect(await fs.readFile(path.join(repo, unicodePath), "utf8")).toBe(unicodeContent);
    expect((await fs.stat(path.join(repo, "fixture.sh"))).mode & 0o111).not.toBe(0);
    expect(await gitAt(repo, "remote", "get-url", "origin")).toBe(repositoryUrl);
    const storedConfig = await fs.readFile(path.join(repo, ".git/config"), "utf8");
    expect(storedConfig).not.toMatch(/credential|include|filter|fsmonitor|insteadOf/i);
    expect(await exists(path.join(repo, ".git/hooks"))).toBe(false);
    expect(await instance.inspect(approved, operationId, sandboxId, async () => undefined)).toEqual(evidence);
    expect(fixture.mutations()).toHaveLength(0);
    expect(fixture.authorizationChecks.every(Boolean)).toBe(true);
    expect(provider.getPrivateGitSessionProcess).toHaveBeenCalledWith(sandboxId);
    expect(local.activeCommands.size).toBe(0);
    for (const call of local.calls.commands) {
      expect(call.request.suppressInputEcho).toBe(true);
      expect(call.request.command).not.toContain(unicodeContent);
      expect(call.request.command).not.toContain(Buffer.from(unicodeContent).toString("base64"));
      expect(call.request.command).not.toContain(credential);
    }
    expect(JSON.stringify(local.calls.inputs)).not.toContain(credential);
    expect(JSON.stringify(evidence)).not.toContain(unicodeContent);
  }, 30_000);

  it("rejects wrong sandbox mapping before any initialization command", async () => {
    const instance = transport(remote());
    await instance.prepare(scope(), async () => undefined);
    await expect(instance.initialize(scope(), operationId, "unrelated-daytona", async () => undefined)).rejects.toThrow();
    expect(provider.getPrivateGitSessionProcess).toHaveBeenCalledWith("unrelated-daytona");
    expect(local.calls.commands).toHaveLength(0);
    expect(await exists(path.join(destination, "repo"))).toBe(false);
  });

  it.each(["wrong repository", "wrong branch", "changed head", "tampered blob", "missing ancestor", "truncated tree"])("rejects %s before any sandbox mutation", async fault => {
    const fixture = remote({ afterResponse: (call, response) => {
      const value = response as Record<string, unknown>;
      if (fault === "wrong repository" && call.path === "") return { ...value, full_name: "unrelated/repository" };
      if (fault === "wrong branch" && call.path.startsWith("/git/ref/")) return { ...value, ref: "refs/heads/unapproved" };
      if (fault === "changed head" && call.path.startsWith("/git/ref/")) return { ...value, object: { type: "commit", sha: "f".repeat(40) } };
      if (fault === "tampered blob" && call.path.startsWith("/git/blobs/")) return { ...value, content: Buffer.from("tampered").toString("base64"), size: 8 };
      if (fault === "truncated tree" && call.path.startsWith("/git/trees/")) return { ...value, truncated: true };
      return response;
    } });
    if (fault === "missing ancestor") fixture.objects.delete(history.split("\n").at(-1)!);
    await expect(transport(fixture).prepare(scope(), async () => undefined)).rejects.toThrow();
    expect(local.calls.commands).toHaveLength(0);
    expect(await fs.readdir(destination)).toEqual([]);
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("never clones over existing repository history or unrelated destination contents", async () => {
    const repo = path.join(destination, "repo"); await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, "owner-file.txt"), "Keep original files intact\n");
    await gitAt(repo, "init", "-b", "historical"); await gitAt(repo, "add", "--", "owner-file.txt");
    await gitAt(repo, "-c", "commit.gpgSign=false", "commit", "-m", "Preserved history");
    const originalHead = await gitAt(repo, "rev-parse", "HEAD");
    const instance = transport(remote()); await instance.prepare(scope(), async () => undefined);
    await expect(instance.initialize(scope(), operationId, sandboxId, async () => undefined)).rejects.toThrow();
    expect(local.calls.commands).toHaveLength(1);
    expect(await gitAt(repo, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await gitAt(repo, "symbolic-ref", "--short", "HEAD")).toBe("historical");
    expect(await fs.readFile(path.join(repo, "owner-file.txt"), "utf8")).toBe("Keep original files intact\n");
  }, 20_000);

  it.each(["oversized object", "symbolic link"])("rejects an actual source repository with an %s", async fault => {
    if (fault === "oversized object") await fs.writeFile(path.join(source, "unsupported.dat"), Buffer.alloc(256 * 1024 + 1, 42));
    else await fs.symlink("README.md", path.join(source, "unsupported.dat"));
    await gitAt(source, "add", "--", "unsupported.dat");
    await gitAt(source, "-c", "commit.gpgSign=false", "commit", "-m", "Unsupported fixture");
    head = await gitAt(source, "rev-parse", "HEAD"); objects = await collectObjects();
    const fixture = remote();
    await expect(transport(fixture).prepare(scope(), async () => undefined)).rejects.toThrow();
    expect(local.calls.commands).toHaveLength(0);
    expect(await fs.readdir(destination)).toEqual([]);
    expect(await gitAt(source, "rev-parse", "HEAD")).toBe(head);
  });

  it("rejects revocation or credential invalidation before dispatch", async () => {
    const fixture = remote(), instance = transport(fixture);
    const revalidate = async () => { throw new ExecutionAuthorizationError(401); };
    await expect(instance.prepare(scope(), revalidate)).rejects.toThrow();
    expect(fixture.fetcher).not.toHaveBeenCalled(); expect(local.calls.commands).toHaveLength(0);
  });

  it.each(["revocation", "credential rotation", "cancellation"])("does not publish staged files after %s before commit", async reason => {
    const fixture = remote(), instance = transport(fixture), controller = new AbortController();
    let invalid = false, reachedStaging = false;
    const revalidate = async () => { if (invalid) throw new ExecutionAuthorizationError(401); };
    await instance.prepare(scope(), revalidate, controller.signal);
    logHook = logs => {
      if (logs.stdout.includes("CR8OR-REPOSITORY/1 STAGED\n")) {
        reachedStaging = true;
        if (reason === "cancellation") controller.abort(); else invalid = true;
      }
    };
    await expect(instance.initialize(scope(), operationId, sandboxId, revalidate, controller.signal)).rejects.toThrow();
    expect(reachedStaging).toBe(true);
    expect(await exists(path.join(destination, "repo"))).toBe(false);
    expect(local.calls.inputs.some(call => call.data === "COMMIT\n")).toBe(false);
    expect(local.activeCommands.size).toBe(0);
    expect(fixture.mutations()).toHaveLength(0);
  }, 20_000);

  it("leaves the destination absent when the content stream disconnects midway", async () => {
    const fixture = remote(), instance = transport(fixture);
    await instance.prepare(scope(), async () => undefined);
    const original = local.sendSessionCommandInput;
    let interrupted = false;
    local.sendSessionCommandInput = async (sessionId, commandId, data) => {
      if (!interrupted && data.startsWith('{"version":1')) {
        interrupted = true;
        await original(sessionId, commandId, data.slice(0, Math.floor(data.length / 2)));
        local.activeCommands.get(commandId)!.child.stdin.end();
        throw new Error(`Synthetic provider disconnect ${credential}`);
      }
      return original(sessionId, commandId, data);
    };
    let failure: unknown;
    try { await instance.initialize(scope(), operationId, sandboxId, async () => undefined); } catch (error) { failure = error; }
    expect(interrupted).toBe(true); expect(failure).toBeDefined();
    expect(String(failure)).not.toContain(credential);
    expect(await exists(path.join(destination, "repo"))).toBe(false);
    expect(local.calls.inputs.some(call => call.data === "COMMIT\n")).toBe(false);
    expect(local.activeCommands.size).toBe(0);
  }, 20_000);

  it("never automatically recreates a repository after an ambiguous completion and verifies it read-only", async () => {
    const fixture = remote(), instance = transport(fixture), approved = scope();
    await instance.prepare(approved, async () => undefined);
    logTransform = logs => {
      if (!logs.stdout.includes("CR8OR-REPOSITORY/1 RESULT ")) return logs;
      const stdout = logs.stdout.replace(/CR8OR-REPOSITORY\/1 RESULT [^\n]+\n/g,
        'CR8OR-REPOSITORY/1 RESULT {"ok":false,"error":"UNCERTAIN"}\n');
      return { ...logs, stdout, output: stdout + logs.stderr };
    };
    await expect(instance.initialize(approved, operationId, sandboxId, async () => undefined)).rejects.toThrow();
    const repo = path.join(destination, "repo");
    expect(await gitAt(repo, "rev-parse", "HEAD")).toBe(head);
    expect(local.calls.inputs.filter(call => call.data === "COMMIT\n")).toHaveLength(1);
    logTransform = undefined;
    expect(await instance.inspect(approved, operationId, sandboxId, async () => undefined)).toMatchObject({
      status: "complete", head, branch: "main", historyVerified: true,
    });
    expect(local.calls.inputs.filter(call => call.data === "COMMIT\n")).toHaveLength(1);
    expect(await gitAt(repo, "rev-list", "HEAD")).toBe(history);
  }, 25_000);

  it("distinguishes absent, incomplete and unexpected initialized repositories without corrective mutations", async () => {
    const instance = transport(remote()), approved = scope();
    await instance.prepare(approved, async () => undefined);
    expect(await instance.inspect(approved, operationId, sandboxId, async () => undefined)).toMatchObject({ status: "absent", historyVerified: false });
    const abandoned = path.join(destination, ".cr8or-init-disconnected");
    await fs.mkdir(abandoned); await fs.writeFile(path.join(abandoned, "preserve.txt"), "Unresolved original reservation");
    expect(await instance.inspect(approved, operationId, sandboxId, async () => undefined)).toMatchObject({ status: "incomplete", historyVerified: false });
    expect(await fs.readFile(path.join(abandoned, "preserve.txt"), "utf8")).toBe("Unresolved original reservation");
    // Test infrastructure alone removes its disposable incomplete fixture.
    await fs.rm(abandoned, { recursive: true });
    await instance.initialize(approved, operationId, sandboxId, async () => undefined);
    const repo = path.join(destination, "repo"), oldest = history.split("\n").at(-1)!;
    await fs.writeFile(path.join(repo, ".git/refs/heads/main"), oldest + "\n");
    expect(await instance.inspect(approved, operationId, sandboxId, async () => undefined)).toMatchObject({ status: "mismatched", head: null, historyVerified: false });
    expect(await gitAt(repo, "rev-parse", "HEAD")).toBe(oldest);
    expect(local.calls.inputs.filter(call => call.data === "COMMIT\n")).toHaveLength(1);
  }, 30_000);

  it("rejects a duplicate initialization rather than overwriting the successful repository", async () => {
    const { instance, approved } = await initialized();
    const repo = path.join(destination, "repo"), originalInode = (await fs.stat(repo)).ino;
    await expect(instance.initialize(approved, operationId, sandboxId, async () => undefined)).rejects.toThrow();
    expect((await fs.stat(repo)).ino).toBe(originalInode);
    expect(await gitAt(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await gitAt(repo, "rev-list", "HEAD")).toBe(history);
    expect(local.calls.inputs.filter(call => call.data === "COMMIT\n")).toHaveLength(1);
  }, 25_000);

  it("keeps every private release restriction active", () => {
    for (const gate of [assertPrivateRepositoryCloningAvailable, assertWorkspaceLifecycleAvailable, assertPrivateGitAvailable,
      assertPrivateCloudCommandAvailable, assertPrivateCloudWriteTransportAvailable]) expect(gate).toThrow();
  });
});
