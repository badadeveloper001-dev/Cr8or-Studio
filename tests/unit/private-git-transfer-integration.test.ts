import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { buildGitOperationScope, gitScopeDigest, parseGitOperation } from "@/lib/security/git-operation-catalogue";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { createGithubObjectTransferAdapter } from "@/lib/workspace/private-git-operations";
import { PRIVATE_GIT_PROGRAM } from "@/lib/workspace/private-git-program";
import { privateGitSession } from "@/lib/workspace/private-git-session";
import { assertPrivateGitAvailable } from "@/lib/workspace/private-git-availability";
import { assertPrivateCloudCommandAvailable } from "@/lib/workspace/private-cloud-command-availability";
import { assertPrivateCloudWriteTransportAvailable } from "@/lib/workspace/private-cloud-write-availability";
import { assertWorkspaceLifecycleAvailable } from "@/lib/workspace/private-workspace-lifecycle-availability";
import type { DaytonaProvider } from "@/lib/workspace/providers/daytona";
import { createControlledDaytonaSessionAdapter, type ControlledSessionLogs } from "../helpers/daytona-session-adapter";
import { createGitObjectGithubAdapter, type SyntheticGitObject } from "../helpers/git-object-github-adapter";

const execute = promisify(execFile);
const repositoryKey = "badadeveloper001-dev/cr8or-studio";
const credential = "synthetic_fixture_credential";
const registration = { projectId: "synthetic-transfer-project", workspace: {
  id: "synthetic-transfer-registration", runtimeType: "cloud" as const, provider: "daytona",
  providerWorkspaceId: "synthetic-transfer-daytona", repositoryUrl: `https://github.com/${repositoryKey}.git`, branch: "main",
} };
let root: string, repo: string, initialHead: string;
let local: ReturnType<typeof createControlledDaytonaSessionAdapter>;
let provider: DaytonaProvider;
let initialObjects: SyntheticGitObject[];
let transformLogs: ((logs: ControlledSessionLogs) => ControlledSessionLogs) | undefined;
type State = { head: string; index: string; title?: string };

const gitEnvironment = (): NodeJS.ProcessEnv => ({ NODE_ENV: "test", PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Synthetic owner", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic owner", GIT_COMMITTER_EMAIL: "test@example.invalid", TZ: "UTC" });
async function git(...args: string[]) {
  return (await execute("git", args, { cwd: repo, env: gitEnvironment() })).stdout.trim();
}
async function objectsAt(head: string): Promise<SyntheticGitObject[]> {
  const objects: SyntheticGitObject[] = [];
  for (const line of (await git("rev-list", "--objects", head)).split("\n")) {
    const oid = line.split(" ")[0], type = await git("cat-file", "-t", oid) as SyntheticGitObject["type"];
    const raw = await execute("git", ["cat-file", type, oid], { cwd: repo, env: gitEnvironment(), encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
    objects.push({ oid, type, contentBase64: raw.stdout.toString("base64") });
  }
  return objects;
}
async function localOperation(value: unknown) {
  const request = parseGitOperation(value);
  const receipt = await privateGitSession(local, request, buildGitOperationScope(registration, request), async () => undefined, new AbortController().signal);
  expect(receipt.status).toBe("SUCCEEDED");
  return receipt.data as State;
}
async function commit(contents: string) {
  await fs.writeFile(path.join(repo, "README.md"), contents);
  const before = await localOperation({ operation: "branch" });
  const staged = await localOperation({ operation: "stage", branch: "main", paths: ["README.md"], expectedHead: before.head, expectedIndex: before.index });
  return localOperation({ operation: "commit", branch: "main", expectedHead: staged.head, expectedIndex: staged.index, category: "Code improvements" });
}
function approval(targetCommit: string, expectedRemoteHead = initialHead) {
  const request = parseGitOperation({ operation: "push", branch: "main", expectedRemoteHead, targetCommit });
  return { request, scope: buildGitOperationScope(registration, request) };
}
function remote(options: Partial<Parameters<typeof createGitObjectGithubAdapter>[0]> = {}) {
  return createGitObjectGithubAdapter({ repositoryKey, branch: "main", head: initialHead, objects: initialObjects, ...options });
}
function transfer(fixture: ReturnType<typeof remote>, approved: ReturnType<typeof approval>, revalidate: () => Promise<void> = async () => undefined,
  signal = new AbortController().signal, token = () => credential) {
  return createGithubObjectTransferAdapter(provider, token, fixture.fetcher).execute(approved.request, approved.scope, revalidate, signal);
}
function alterExport(change: (graph: { objects: SyntheticGitObject[] }) => void) {
  transformLogs = logs => {
    const marker = "CR8OR-GIT/1 RESULT ", offset = logs.stdout.indexOf(marker);
    if (offset < 0) return logs;
    const result = JSON.parse(logs.stdout.slice(offset + marker.length));
    if (!result.ok || !Array.isArray(result.data?.objects)) return logs;
    change(result.data);
    const stdout = logs.stdout.slice(0, offset) + marker + JSON.stringify(result) + "\n";
    return { ...logs, stdout, output: stdout + logs.stderr };
  };
}

beforeEach(async () => {
  transformLogs = undefined;
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-object-transfer-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git("init", "-b", "main");
  await fs.writeFile(path.join(repo, "README.md"), "Synthetic baseline\n");
  await git("add", "--", "README.md");
  await git("-c", "commit.gpgSign=false", "commit", "-m", "Initial synthetic fixture");
  initialHead = await git("rev-parse", "HEAD");
  initialObjects = await objectsAt(initialHead);
  await git("remote", "add", "origin", registration.workspace.repositoryUrl);
  local = createControlledDaytonaSessionAdapter(root, { maximumOutputBytes: 2 * 1024 * 1024, transformLogs: logs => transformLogs?.(logs) ?? logs });
  const owners = new Set([0, (await fs.stat("/usr/bin/git")).uid, (await fs.stat("/")).uid]);
  const program = PRIVATE_GIT_PROGRAM.replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${[...owners].join(",")},)`);
  const original = local.executeSessionCommand;
  local.executeSessionCommand = async (session, request, timeout) => {
    if (request.command !== `exec python3 -I -S -u -c ${shellQuote(PRIVATE_GIT_PROGRAM)}`) throw new Error("Unexpected fixture command.");
    // Adapt trusted installation UID only; actual Python/Git runs locally. This
    // proves protocol integration, not live provider isolation or SDK semantics.
    return original(session, { ...request, command: `exec python3 -I -S -u -c ${shellQuote(program)}` }, timeout);
  };
  provider = { getPrivateGitSessionProcess: vi.fn(async (id: string) => {
    if (id !== registration.workspace.providerWorkspaceId) throw new ExecutionAuthorizationError(403);
    return local;
  }) } as unknown as DaytonaProvider;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await local?.dispose();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("real local Git objects through the trusted export, Git Database upload and existing branch adapter", () => {
  it("preserves actual helper-created commit identities and history across two development cycles", async () => {
    const fixture = remote();
    const content = "Private source: exact UTF-8 你好 🌍\n";
    const first = await commit(content);
    expect(first.title).toBe("CR8OR-001: Code improvements");
    const approved = approval(first.head), digest = gitScopeDigest(approved.scope);
    expect(await transfer(fixture, approved)).toMatchObject({ status: "SUCCEEDED", cancellationConfirmed: true, cleanupConfirmed: true,
      data: { head: first.head, previousHead: initialHead, branch: "main" } });
    expect(fixture.head).toBe(first.head);
    for (const object of await objectsAt(first.head)) expect(fixture.objects.get(object.oid)).toEqual(object);
    expect(gitScopeDigest(approved.scope)).toBe(digest);

    const second = await commit("Second cycle remains exact 🔐\n");
    expect(second.title).toBe("CR8OR-002: Code improvements");
    expect(await transfer(fixture, approval(second.head, first.head))).toMatchObject({ status: "SUCCEEDED", data: { head: second.head, previousHead: first.head } });
    for (const object of await objectsAt(second.head)) expect(fixture.objects.get(object.oid)).toEqual(object);
    expect(await git("rev-list", "HEAD")).toBe([second.head, first.head, initialHead].join("\n"));
    expect(await git("show", `${first.head}:README.md`)).toBe(content.trim());
    expect(fixture.mutations().filter(call => call.method === "PATCH").map(call => call.body)).toEqual([
      { sha: first.head, force: false }, { sha: second.head, force: false },
    ]);
    expect(provider.getPrivateGitSessionProcess).toHaveBeenCalledTimes(2);
    expect(provider.getPrivateGitSessionProcess).toHaveBeenCalledWith(registration.workspace.providerWorkspaceId);
    expect(local.activeCommands.size).toBe(0);
    for (const call of local.calls.commands) {
      expect(call.request.command).not.toContain(content);
      expect(call.request.command).not.toContain(Buffer.from(content).toString("base64"));
      expect(call.request.command).not.toContain(credential);
      expect(call.request.suppressInputEcho).toBe(true);
    }
    expect(JSON.stringify(local.calls.inputs)).not.toContain(credential);
  }, 30_000);

  it("uploads a complete two-commit ancestry before advancing the exact approved branch", async () => {
    const first = await commit("First pending commit\n"), second = await commit("Second pending commit\n"), fixture = remote();
    expect(await transfer(fixture, approval(second.head))).toMatchObject({ status: "SUCCEEDED", data: { head: second.head } });
    expect(fixture.objects.get(first.head)).toBeDefined();
    expect(fixture.objects.get(second.head)).toBeDefined();
    expect(fixture.mutations().filter(call => call.path === "/git/commits")).toHaveLength(2);
    expect(fixture.mutations().filter(call => call.method === "PATCH")).toHaveLength(1);
  }, 30_000);

  it.each(["repository", "branch", "head"])("rejects a changed local %s before any remote mutation", async change => {
    const first = await commit("Approved source\n"), fixture = remote(), approved = approval(first.head);
    if (change === "repository") await git("remote", "set-url", "origin", "https://github.com/unrelated/project.git");
    if (change === "branch") await git("checkout", "-b", "other");
    if (change === "head") await commit("Unapproved local commit\n");
    expect((await transfer(fixture, approved)).status).not.toBe("SUCCEEDED");
    expect(fixture.mutations()).toHaveLength(0);
    expect(fixture.head).toBe(initialHead);
  }, 25_000);

  it("rejects a substituted sandbox before obtaining or sending credentials", async () => {
    const first = await commit("Bound source\n"), fixture = remote(), approved = approval(first.head), token = vi.fn(() => credential);
    const altered = { ...approved, scope: { ...approved.scope, providerWorkspaceId: "unrelated-daytona" } };
    await expect(transfer(fixture, altered, async () => undefined, new AbortController().signal, token)).rejects.toMatchObject({ status: 403 });
    expect(token).not.toHaveBeenCalled();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it.each(["tampered blob", "missing tree", "missing parent"])("rejects an exported %s without remote mutation", async fault => {
    await commit("First pending source\n");
    const second = await commit("Second pending source\n"), fixture = remote();
    alterExport(graph => {
      if (fault === "tampered blob") graph.objects.find(object => object.type === "blob")!.contentBase64 = Buffer.from("Tampered").toString("base64");
      else {
        const index = graph.objects.findIndex(object => fault === "missing tree" ? object.type === "tree" : object.type === "commit" && object.oid !== second.head);
        graph.objects.splice(index, 1);
      }
    });
    await expect(transfer(fixture, approval(second.head))).rejects.toThrow("Git object transfer could not be verified.");
    expect(fixture.mutations()).toHaveLength(0);
    expect(fixture.head).toBe(initialHead);
    expect(await git("rev-parse", "HEAD")).toBe(second.head);
  }, 25_000);

  it("rejects oversized source blobs without truncation or remote writes", async () => {
    const content = "x".repeat(256 * 1024 + 1), first = await commit(content), fixture = remote();
    expect((await transfer(fixture, approval(first.head))).status).not.toBe("SUCCEEDED");
    expect(fixture.mutations()).toHaveLength(0);
    expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe(content);
  }, 20_000);

  it("rejects a remote branch change before upload", async () => {
    const first = await commit("Approved source\n"), fixture = remote();
    fixture.setHead("f".repeat(40));
    expect((await transfer(fixture, approval(first.head))).status).not.toBe("SUCCEEDED");
    expect(fixture.mutations()).toHaveLength(0);
  });

  it("returns UNKNOWN after object upload if the branch changes, without force-push or retry", async () => {
    const first = await commit("Approved source\n");
    const fixture = remote({ afterResponse: (call, response) => {
      if (call.method === "POST") fixture.setHead("f".repeat(40));
      return response;
    } });
    expect(await transfer(fixture, approval(first.head))).toMatchObject({ status: "UNKNOWN", cancellationConfirmed: false, cleanupConfirmed: false });
    expect(fixture.mutations().filter(call => call.method === "PATCH")).toHaveLength(0);
    expect(fixture.head).toBe("f".repeat(40));
  });

  it("keeps uploaded objects unresolved when the existing push adapter rejects non-fast-forward advancement", async () => {
    const first = await commit("Approved source\n"), fixture = remote();
    fixture.setComparison("diverged");
    expect(await transfer(fixture, approval(first.head))).toMatchObject({ status: "UNKNOWN" });
    expect(fixture.mutations().some(call => call.method === "POST")).toBe(true);
    expect(fixture.mutations().filter(call => call.method === "PATCH")).toHaveLength(0);
    expect(fixture.head).toBe(initialHead);
  });

  it("stops after authorization is revoked between export and upload", async () => {
    const first = await commit("Private source\n"), fixture = remote();
    let revoked = false;
    const revalidate = async () => { if (revoked) throw new ExecutionAuthorizationError(401); };
    const result = await transfer(fixture, approval(first.head), revalidate, new AbortController().signal, () => { revoked = true; return credential; });
    expect(result.status).not.toBe("SUCCEEDED");
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.head).toBe(initialHead);
  });

  it.each(["revocation", "abort"])("does not release output or retry when %s occurs after an object mutation", async failure => {
    const first = await commit("Private uploaded source\n"), controller = new AbortController();
    let revoked = false;
    const fixture = remote({ afterResponse: (call, response) => {
      if (call.method === "POST") { if (failure === "abort") controller.abort(); else revoked = true; }
      return response;
    } });
    const revalidate = async () => { if (revoked) throw new ExecutionAuthorizationError(401); };
    const result = await transfer(fixture, approval(first.head), revalidate, controller.signal);
    expect(result).toMatchObject({ status: "UNKNOWN" });
    expect(result.data).toBeUndefined();
    expect(fixture.mutations()).toHaveLength(1);
    expect(fixture.head).toBe(initialHead);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain("Private uploaded source");
  });

  it("keeps ambiguous final ref acknowledgement UNKNOWN with one dispatch and no corrective mutation", async () => {
    const first = await commit("Ambiguous transfer\n");
    const fixture = remote({ afterResponse: (call, response) => {
      if (call.method === "PATCH") throw new Error(`Synthetic provider failure ${credential}`);
      return response;
    } });
    const result = await transfer(fixture, approval(first.head));
    expect(result).toMatchObject({ status: "UNKNOWN", cancellationConfirmed: false, cleanupConfirmed: false });
    expect(fixture.head).toBe(first.head);
    expect(fixture.mutations().filter(call => call.method === "PATCH")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("preserves every hardcoded private execution release restriction", () => {
    for (const gate of [assertPrivateGitAvailable, assertPrivateCloudCommandAvailable, assertPrivateCloudWriteTransportAvailable, assertWorkspaceLifecycleAvailable]) {
      expect(gate).toThrow(expect.objectContaining({ status: 503 }));
    }
    expect(local.calls.commands).toHaveLength(0);
  });
});
