import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { buildGitOperationScope, parseGitOperation, type GitOperationRequest } from "@/lib/security/git-operation-catalogue";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { PRIVATE_GIT_OBJECT_LIMITS, PRIVATE_GIT_PROGRAM } from "@/lib/workspace/private-git-program";
import { privateGitObjectSession, privateGitSession } from "@/lib/workspace/private-git-session";
import { createControlledDaytonaSessionAdapter } from "../helpers/daytona-session-adapter";

const execute = promisify(execFile);
const registration = { projectId: "synthetic-export-project", workspace: {
  id: "synthetic-export-registration", runtimeType: "cloud" as const, provider: "daytona", providerWorkspaceId: "synthetic-export-sandbox",
  repositoryUrl: "https://github.com/badadeveloper001-dev/cr8or-studio.git", branch: "main",
} };
type Graph = { version: number; repositoryKey: string; branch: string; head: string; base: string;
  objects: Array<{ oid: string; type: "blob" | "tree" | "commit"; contentBase64: string }> };
let root: string, repo: string, base: string;
let adapter: ReturnType<typeof createControlledDaytonaSessionAdapter>;
let program: string;
async function git(...args: string[]) {
  return (await execute("git", args, { cwd: repo, env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: root, TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Synthetic owner", GIT_AUTHOR_EMAIL: "owner@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic owner", GIT_COMMITTER_EMAIL: "owner@example.invalid", GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" } })).stdout.trim();
}
async function commit(file = "source.ts", content: string | Buffer = "export const value = '你好 🌍';\n") {
  await fs.writeFile(path.join(repo, file), content);
  await git("add", "--", file);
  await git("-c", "commit.gpgSign=false", "commit", "-m", "CR8OR-001: Code improvements");
  return git("rev-parse", "HEAD");
}
async function writeObject(type: "tree" | "blob" | "commit", content: string | Buffer): Promise<string> {
  const file = path.join(root, "fixture-object");
  await fs.writeFile(file, content);
  // Deliberately permit malformed fixture objects to exercise rejection.
  return git("hash-object", "--literally", "-t", type, "-w", "--", file);
}
async function installCommit(tree: string, additions = "", parent = base): Promise<string> {
  const oid = await writeObject("commit", `tree ${tree}\nparent ${parent}\n${additions}author Synthetic owner <owner@example.invalid> 1700000000 +0000\ncommitter Synthetic owner <owner@example.invalid> 1700000000 +0000\n\nCR8OR-001: Code improvements\n`);
  await git("update-ref", "refs/heads/main", oid);
  return oid;
}
function configureAdapter(options: Parameters<typeof createControlledDaytonaSessionAdapter>[1] = {}) {
  adapter = createControlledDaytonaSessionAdapter(root, { maximumOutputBytes: PRIVATE_GIT_OBJECT_LIMITS.outputBytes, ...options });
  const original = adapter.executeSessionCommand;
  adapter.executeSessionCommand = async (session, request, timeout) => {
    if (request.command !== `exec python3 -I -S -u -c ${shellQuote(PRIVATE_GIT_PROGRAM)}`) throw new Error("Unexpected test command.");
    return original(session, { ...request, command: `exec python3 -I -S -u -c ${shellQuote(program)}` }, timeout);
  };
}
async function exportObjects(options: { head?: string; remote?: string; request?: GitOperationRequest; validate?: () => Promise<void>; signal?: AbortSignal } = {}) {
  const request = options.request ?? parseGitOperation({ operation: "push", branch: "main", targetCommit: options.head ?? await git("rev-parse", "HEAD"), expectedRemoteHead: options.remote ?? base });
  return privateGitObjectSession(adapter, request, buildGitOperationScope(registration, request), options.validate ?? (async () => undefined), options.signal ?? new AbortController().signal);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-object-export-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git("init", "-b", "main");
  await fs.writeFile(path.join(repo, "README.md"), "Synthetic base contents\n");
  await git("add", "--", "README.md");
  await git("-c", "commit.gpgSign=false", "commit", "-m", "Initial synthetic commit");
  await git("remote", "add", "origin", registration.workspace.repositoryUrl);
  base = await git("rev-parse", "HEAD");
  const owners = new Set([0, (await fs.stat("/usr/bin/git")).uid, (await fs.stat("/")).uid]);
  program = PRIVATE_GIT_PROGRAM.replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${[...owners].join(",")},)`);
  configureAdapter();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await adapter?.dispose();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("bounded private Git object export through actual Git and controlled Daytona sessions", () => {
  it("exports the real helper's exact UTC commits, binary/empty files and Unicode under a non-UTC provider environment", async () => {
    vi.stubEnv("TZ", "Pacific/Honolulu");
    const content = Buffer.from("export const value = '你好 🌍';\n", "utf8");
    await fs.writeFile(path.join(repo, "source.ts"), content);
    await fs.writeFile(path.join(repo, "empty.txt"), "");
    await fs.writeFile(path.join(repo, "binary.dat"), Buffer.from([0, 255, 128, 10]));
    const local = async (value: unknown) => {
      const request = parseGitOperation(value);
      return privateGitSession(adapter, request, buildGitOperationScope(registration, request), async () => undefined, new AbortController().signal);
    };
    const state = (await local({ operation: "branch" })).data as { head: string; index: string };
    const staged = (await local({ operation: "stage", branch: "main", paths: ["source.ts", "empty.txt", "binary.dat"], expectedHead: state.head, expectedIndex: state.index })).data as { head: string; index: string };
    const committed = await local({ operation: "commit", branch: "main", expectedHead: staged.head, expectedIndex: staged.index, category: "Code improvements" });
    expect(committed.status).toBe("SUCCEEDED");
    const result = await exportObjects();
    expect(result).toMatchObject({ status: "SUCCEEDED", cancellationConfirmed: true, cleanupConfirmed: true });
    const graph = result.data as Graph;
    expect(graph).toMatchObject({ version: 1, repositoryKey: "badadeveloper001-dev/cr8or-studio", branch: "main", head: await git("rev-parse", "HEAD"), base });
    expect(graph.objects.some((object) => object.oid === base)).toBe(false);
    const createdCommit = Buffer.from(graph.objects.find((object) => object.type === "commit")!.contentBase64, "base64").toString("utf8");
    expect(createdCommit).toMatch(/author .+ \+0000\ncommitter .+ \+0000\n/);
    expect(createdCommit).not.toContain("-1000");
    for (const object of graph.objects) {
      const raw = Buffer.from(object.contentBase64, "base64");
      expect(createHash("sha1").update(`${object.type} ${raw.length}\0`).update(raw).digest("hex")).toBe(object.oid);
    }
    expect(graph.objects.filter((object) => object.type === "blob").map((object) => object.contentBase64)).toEqual(expect.arrayContaining([
      content.toString("base64"), "", Buffer.from([0, 255, 128, 10]).toString("base64"),
    ]));
    expect(adapter.activeCommands.size).toBe(0);
    for (const call of adapter.calls.commands) {
      expect(call.request.command).not.toContain(content.toString("utf8"));
      expect(call.request.command).not.toContain(content.toString("base64"));
      expect(call.request.command).not.toContain(base);
      expect(call.request.suppressInputEcho).toBe(true);
    }
    expect(await git("rev-list", "--count", "HEAD")).toBe("2");
  }, 15_000);

  it("preserves all new linear ancestors and every complete tree until the verified remote boundary", async () => {
    const first = await commit();
    const second = await commit("next.ts", "export const second = true;\n");
    const result = await exportObjects();
    expect(result.status).toBe("SUCCEEDED");
    const graph = result.data as Graph;
    expect(graph.objects.filter((object) => object.type === "commit").map((object) => object.oid).sort()).toEqual([first, second].sort());
    expect(graph.objects.some((object) => object.oid === base)).toBe(false);
    expect(await git("rev-parse", "HEAD")).toBe(second);
  });

  it.each(["missing-base", "wrong-head", "wrong-branch", "wrong-repository", "shallow-history"])("rejects %s without graph release or history modification", async (scenario) => {
    const head = await commit();
    if (scenario === "wrong-branch") await git("switch", "-c", "other");
    if (scenario === "wrong-repository") await git("remote", "set-url", "origin", "https://github.com/other/repository.git");
    if (scenario === "shallow-history") await fs.writeFile(path.join(repo, ".git/shallow"), base + "\n");
    const result = await exportObjects({ head: scenario === "wrong-head" ? "b".repeat(40) : head, remote: scenario === "missing-base" ? "a".repeat(40) : base });
    expect(result.status).toBe("FAILED");
    expect(result).not.toHaveProperty("data");
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(adapter.activeCommands.size).toBe(0);
  });

  it.each([".env", ".env.example", "secrets", "private.key", "file?.ts", ".aws"])("rejects sensitive or unsupported tree path %s", async (name) => {
    await commit(name, "synthetic private content");
    expect(await exportObjects()).toMatchObject({ status: "FAILED" });
  });

  it.each(["symlink", "hard-link", "submodule"])("rejects %s repository content", async (kind) => {
    if (kind === "symlink") { await fs.symlink("README.md", path.join(repo, "linked")); await git("add", "--", "linked"); }
    else if (kind === "hard-link") { await fs.link(path.join(repo, "README.md"), path.join(repo, "linked")); await git("add", "--", "linked"); }
    else await git("update-index", "--add", "--cacheinfo", `160000,${base},module`);
    await git("-c", "commit.gpgSign=false", "commit", "-m", "CR8OR-001: Code improvements");
    expect(await exportObjects()).toMatchObject({ status: "FAILED" });
  });

  it.each(["merge", "extra-header", "non-UTC", "incomplete-ancestry", "missing-blob", "malformed-tree"])("rejects %s object graphs", async (kind) => {
    const tree = await git("rev-parse", "HEAD^{tree}");
    if (kind === "merge") await installCommit(tree, `parent ${base}\n`);
    else if (kind === "extra-header") await installCommit(tree, "encoding ISO-8859-1\n");
    else if (kind === "non-UTC") {
      const oid = await installCommit(tree);
      const raw = (await git("cat-file", "commit", oid)).replaceAll("+0000", "+0100") + "\n";
      await git("update-ref", "refs/heads/main", await writeObject("commit", raw));
    } else if (kind === "incomplete-ancestry") await installCommit(tree, "", "f".repeat(40));
    else if (kind === "missing-blob") {
      await commit();
      const blob = await git("rev-parse", "HEAD:source.ts");
      await fs.unlink(path.join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    } else {
      const malformed = await writeObject("tree", Buffer.concat([Buffer.from("100644 file\0"), Buffer.from(base, "hex")]));
      await installCommit(malformed);
    }
    expect(await exportObjects()).toMatchObject({ status: "FAILED" });
  });

  it.each(["blob", "tree", "commit"])("cryptographically rejects tampered local %s payloads", async (type) => {
    const head = await commit();
    const oid = type === "commit" ? head : await git("rev-parse", type === "tree" ? "HEAD^{tree}" : "HEAD:source.ts");
    const location = path.join(repo, ".git/objects", oid.slice(0, 2), oid.slice(2));
    const raw = inflateSync(await fs.readFile(location));
    raw[raw.length - 1] ^= 1;
    await fs.chmod(location, 0o600);
    await fs.writeFile(location, deflateSync(raw));
    const result = await exportObjects({ head });
    expect(result.status).toBe("FAILED");
    expect(result).not.toHaveProperty("data");
  });

  it("rejects traversal encoded in a raw tree object", async () => {
    const blob = await writeObject("blob", "synthetic");
    const tree = await writeObject("tree", Buffer.concat([Buffer.from("100644 ../outside\0"), Buffer.from(blob, "hex")]));
    await installCommit(tree);
    expect(await exportObjects()).toMatchObject({ status: "FAILED" });
  });

  it("rejects an individual oversized blob before releasing partial contents", async () => {
    await commit("large.txt", Buffer.alloc(PRIVATE_GIT_OBJECT_LIMITS.objectBytes + 1, 65));
    const result = await exportObjects();
    expect(result).toMatchObject({ status: "FAILED" });
    expect(result).not.toHaveProperty("data");
  });

  it.each(["MAX_EXPORT_COMMITS=1", "MAX_EXPORT_OBJECTS=1", "MAX_EXPORT_TOTAL=1", "MAX_EXPORT_ENTRIES=1"])("enforces the bounded export budget %s", async (limit) => {
    await commit();
    await commit("second.ts", "second");
    program = program.replace(new RegExp(`${limit.split("=")[0]}=[0-9]+`), limit);
    expect(await exportObjects()).toMatchObject({ status: "FAILED" });
  });

  it("preserves an exactly maximum-size blob without truncation", async () => {
    const content = Buffer.alloc(PRIVATE_GIT_OBJECT_LIMITS.objectBytes, 65);
    await commit("maximum.txt", content);
    const result = await exportObjects();
    expect(result.status).toBe("SUCCEEDED");
    expect((result.data as Graph).objects.some((object) => object.type === "blob" && Buffer.from(object.contentBase64, "base64").equals(content))).toBe(true);
  });

  it("rejects the real aggregate byte ceiling rather than emitting a partial graph", async () => {
    for (let index = 0; index < 5; index++) {
      await fs.writeFile(path.join(repo, `large-${index}.dat`), Buffer.alloc(PRIVATE_GIT_OBJECT_LIMITS.objectBytes, 65 + index));
    }
    await git("add", "--", ".");
    await git("-c", "commit.gpgSign=false", "commit", "-m", "CR8OR-001: Code improvements");
    const result = await exportObjects();
    expect(result.status).toBe("FAILED");
    expect(result).not.toHaveProperty("data");
  });

  it("rejects a branch change at the START authorization boundary", async () => {
    await commit();
    await adapter.dispose();
    configureAdapter({ beforeInput: async (input) => { if (input === "START\n") await git("switch", "-c", "unexpected"); } });
    expect(await exportObjects()).toMatchObject({ status: "FAILED" });
  });

  it("sanitizes a provider disconnect and never treats incomplete object delivery as successful", async () => {
    await commit();
    const read = adapter.getSessionCommandLogs;
    let failOnce = true;
    adapter.getSessionCommandLogs = (async (session: string, command: string) => {
      const logs = await read(session, command);
      if (failOnce && logs.stdout.includes("RESULT")) { failOnce = false; throw new Error("synthetic-secret-provider-detail"); }
      return logs;
    }) as typeof read;
    const result = await exportObjects();
    expect(result.status).toBe("UNKNOWN");
    expect(result).not.toHaveProperty("data");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-provider-detail");
    expect(adapter.activeCommands.size).toBe(0);
  });

  it("fails a helper deadline before export and cleans up the timed-out session", async () => {
    await commit();
    program = program.replace("MAX_SECONDS=30", "MAX_SECONDS=1");
    await adapter.dispose();
    configureAdapter({ beforeInput: async (input) => { if (input === "START\n") await new Promise((resolve) => setTimeout(resolve, 1100)); } });
    const result = await exportObjects();
    expect(result.status).not.toBe("SUCCEEDED");
    expect(result).not.toHaveProperty("data");
    expect(adapter.activeCommands.size).toBe(0);
  });

  it("revalidates before START and never returns objects to a revoked session", async () => {
    await commit();
    let checks = 0;
    await expect(exportObjects({ validate: async () => { if (++checks >= 4) throw new ExecutionAuthorizationError(401); } })).rejects.toMatchObject({ status: 401 });
    expect(adapter.calls.inputs.some((input) => input.data === "START\n")).toBe(false);
    expect(adapter.activeCommands.size).toBe(0);
  });

  it("withholds exported objects after credential rotation at completion", async () => {
    await commit();
    let rotated = false;
    adapter.getSessionCommand = async (session, command) => {
      const current = adapter.activeCommands.get(command)!;
      if (current.exitCode !== undefined) rotated = true;
      return { id: command, command: current.request.command, exitCode: current.exitCode };
    };
    await expect(exportObjects({ validate: async () => { if (rotated) throw new ExecutionAuthorizationError(401); } })).rejects.toMatchObject({ status: 401 });
    expect(adapter.activeCommands.size).toBe(0);
  });

  it("withholds incomplete or tampered session metadata and cleans up the execution session", async () => {
    await commit();
    await adapter.dispose();
    configureAdapter({ transformLogs: (logs) => ({ ...logs, stdout: logs.stdout.replace('"head":', '"unapprovedHead":'), output: logs.output.replace('"head":', '"unapprovedHead":') }) });
    const result = await exportObjects();
    expect(result.status).toBe("UNKNOWN");
    expect(result).not.toHaveProperty("data");
    expect(adapter.activeCommands.size).toBe(0);
  });

  it("rejects a substituted project or sandbox through authorization before provider dispatch", async () => {
    await commit();
    await expect(exportObjects({ validate: async () => { throw new ExecutionAuthorizationError(403); } })).rejects.toMatchObject({ status: 403 });
    expect(adapter.calls.created).toEqual([]);
  });

  it("honors an aborted initiating request without starting an export", async () => {
    await commit();
    const controller = new AbortController(); controller.abort();
    await expect(exportObjects({ signal: controller.signal })).rejects.toMatchObject({ status: 401 });
    expect(adapter.calls.created).toEqual([]);
  });

  it("keeps ordinary local Git session semantics separate from object export", async () => {
    await commit();
    const read = parseGitOperation({ operation: "branch" });
    await expect(exportObjects({ request: read })).rejects.toMatchObject({ status: 403 });
    expect(adapter.calls.created).toEqual([]);
  });
});
