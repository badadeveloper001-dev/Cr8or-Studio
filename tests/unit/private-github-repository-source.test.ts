import { afterEach, describe, expect, it, vi } from "vitest";
import { gitObjectId, serializeGitTree, type GitTransferObjectType } from "@/lib/security/git-object-transfer";
import { GIT_REPOSITORY_INITIALIZATION_LIMITS, serializeRepositoryCommit, validateRepositoryInitialization } from "@/lib/security/git-repository-initialization";
import {
  downloadPrivateGithubRepository, GitRepositorySourceError, PRIVATE_GITHUB_REPOSITORY_LIMITS, resolvePrivateGithubRepositoryHead,
} from "@/lib/workspace/private-github-repository-source";
import { createGitObjectGithubAdapter, type SyntheticGitObject, type SyntheticGithubCall } from "../helpers/git-object-github-adapter";

const PERSON = { name: "Synthetic Owner", email: "owner@cr8or.invalid", timestamp: 1700000000, date: "2023-11-14T22:13:20.000Z" };
const TOKEN = "synthetic_read_only_repository_token";
function object(type: GitTransferObjectType, raw: Buffer): SyntheticGitObject {
  return { oid: gitObjectId(type, raw), type, contentBase64: raw.toString("base64") };
}
function fixture(content = Buffer.from("source café 😀\r\n"), count = 2) {
  const blob = object("blob", content);
  const tree = object("tree", serializeGitTree([{ name: "café.ts", mode: "100644", type: "blob", oid: blob.oid }]));
  const commits: SyntheticGitObject[] = [];
  for (let index = 0; index < count; index++) commits.push(object("commit", serializeRepositoryCommit({ tree: tree.oid,
    parent: commits.at(-1)?.oid ?? null, author: PERSON, committer: PERSON, message: `Original historical message ${index}\n\nNot rewritten.\n` })));
  const graph = { version: 1 as const, repositoryKey: "registered-owner/registered-repository", branch: "main", head: commits.at(-1)!.oid,
    objects: [...commits, tree, blob] };
  return { graph, tree, blob, commits, binding: { repositoryKey: graph.repositoryKey, branch: graph.branch, head: graph.head } };
}
function input(f = fixture(), afterResponse?: (call: SyntheticGithubCall, data: unknown) => unknown) {
  const remote = createGitObjectGithubAdapter({ ...f.graph, afterResponse });
  const revalidate = vi.fn(async () => undefined);
  return { f, remote, args: { ...f.binding, token: TOKEN, revalidate, fetch: remote.fetcher } };
}
afterEach(() => vi.useRealTimers());

describe("bounded credential-isolated GitHub repository source", () => {
  it.each([Buffer.alloc(0), Buffer.from("exact café 😀\r\n"), Buffer.from([0, 255, 128, 97])])("preserves all complete root ancestry and exact bytes %#", async content => {
    const { f, remote, args } = input(fixture(content));
    const graph = await downloadPrivateGithubRepository(args);
    const validated = validateRepositoryInitialization(graph, f.binding);
    expect(validated.commits.map(commit => commit.oid)).toEqual(f.commits.map(commit => commit.oid));
    expect(validated.commits[0].parent).toBeNull();
    expect(validated.objects.get(f.blob.oid)?.content).toEqual(content);
    expect([...validated.objects.keys()].sort()).toEqual(f.graph.objects.map(item => item.oid).sort());
    expect(remote.mutations()).toHaveLength(0);
    expect(args.revalidate.mock.calls.length).toBeGreaterThan(remote.calls.length);
    expect(JSON.stringify(graph)).not.toContain(TOKEN);
    expect(remote.calls.filter(call => call.path.endsWith(f.tree.oid))).toHaveLength(1);
  });
  it("resolves an approval HEAD only from canonical repository metadata and stable branch refs", async () => {
    const { f, remote, args } = input();
    expect(await resolvePrivateGithubRepositoryHead(args)).toBe(f.graph.head);
    expect(remote.calls.map(call => call.path)).toEqual(["", "/git/ref/heads/main", "/git/ref/heads/main"]);
  });
  it("supports an empty root tree without inventing source objects", async () => {
    const tree = object("tree", Buffer.alloc(0));
    const commit = object("commit", serializeRepositoryCommit({ tree: tree.oid, parent: null, author: PERSON, committer: PERSON, message: "Empty root\n" }));
    const f = fixture(); f.graph.objects = [commit, tree]; f.graph.head = commit.oid; f.binding.head = commit.oid;
    const { args } = input(f);
    expect((await downloadPrivateGithubRepository(args)).objects).toHaveLength(2);
  });
  it("retains exact repository and slash-separated branch binding", async () => {
    const f = fixture(); f.graph.branch = "feature/approved"; f.binding.branch = f.graph.branch;
    expect((await downloadPrivateGithubRepository(input(f).args)).branch).toBe("feature/approved");
  });
  it("puts the synthetic credential only in HTTPS Authorization headers and denies redirects", async () => {
    const { remote, args } = input();
    await downloadPrivateGithubRepository(args);
    for (const [url, init] of remote.fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.github\.com\/repos\/registered-owner\/registered-repository(?:\/|$)/);
      expect(String(url)).not.toContain(TOKEN); expect(init?.body).toBeUndefined();
      expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
  });
  it.each([
    { repositoryKey: "other/repo?token=secret" }, { repositoryKey: "Registered-Owner/registered-repository" },
    { branch: "../main" }, { branch: "refs/heads/main" }, { branch: "main;curl evil" },
    { head: "not-a-sha" }, { token: "secret\nHeader: attack" }, { token: "" },
  ])("rejects malformed trusted input before provider access %#", async patch => {
    const { args, remote } = input();
    await expect(downloadPrivateGithubRepository({ ...args, ...patch })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(remote.calls).toHaveLength(0);
  });
  it("rejects another repository's metadata even when object SHA values match", async () => {
    const { args, remote } = input(fixture(), (call, data) => call.path === "" ? { full_name: "another/repository" } : data);
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    expect(remote.calls).toHaveLength(1);
  });
  it("rejects a moved initial remote branch without fetching objects", async () => {
    const { args, remote } = input(); remote.setHead("a".repeat(40));
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
    expect(remote.calls).toHaveLength(2);
  });
  it("rejects branch changes during download without substituting a new commit", async () => {
    const f = fixture();
    const { args, remote } = input(f, (call, data) => { if (call.path.endsWith(f.blob.oid)) remote.setHead("a".repeat(40)); return data; });
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
    expect(remote.mutations()).toHaveLength(0);
  });
  it("rejects a branch change while resolving approval data", async () => {
    let reads = 0;
    const { args } = input(fixture(), (call, data) => call.path === "/git/ref/heads/main" && ++reads > 1
      ? { ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } } : data);
    await expect(resolvePrivateGithubRepositoryHead(args)).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
  });
  it.each(["blob", "tree", "commit"])("rejects tampered %s bytes despite a claimed valid SHA", async type => {
    const f = fixture(), target = f.graph.objects.find(item => item.type === type)!;
    const { args } = input(f, (call, data) => {
      if (!call.path.endsWith(target.oid)) return data;
      if (type === "blob") return { ...(data as object), content: Buffer.from("tampered").toString("base64"), size: 8 };
      if (type === "tree") return { ...(data as object), tree: [] };
      return { ...(data as object), message: "Changed history\n" };
    });
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it.each(["blob", "tree", "commit"])("rejects missing required %s objects instead of shallow initialization", async type => {
    const { f, args, remote } = input(); remote.objects.delete(f.graph.objects.find(item => item.type === type)!.oid);
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it.each([
    { parents: [{ sha: "a".repeat(40) }, { sha: "b".repeat(40) }] },
    { verification: { verified: true, reason: "valid", signature: "synthetic-signature", payload: "synthetic-payload" } },
    { author: { name: PERSON.name, email: PERSON.email, date: "2023-11-14T17:13:20-05:00" } },
    { sha: "sha256-unsupported" },
  ])("rejects unsupported commit representations %#", async patch => {
    const { args } = input(fixture(), (call, data) => call.path.includes("/git/commits/") ? { ...(data as object), ...patch } : data);
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it.each(["120000", "160000", "100664"])("rejects unsupported Git file mode %s", async mode => {
    const f = fixture();
    const { args } = input(f, (call, data) => call.path.endsWith(f.tree.oid)
      ? { ...(data as object), tree: [{ path: "unsafe", mode, type: mode === "160000" ? "commit" : "blob", sha: f.blob.oid }] } : data);
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it.each([".env", "../outside", ".gitmodules", "secrets/private", "id_rsa"])("rejects sensitive or unsafe tree paths %s before retrieving blob data", async path => {
    const f = fixture();
    const { args, remote } = input(f, (call, data) => call.path.endsWith(f.tree.oid)
      ? { ...(data as object), tree: [{ path, mode: "100644", type: "blob", sha: f.blob.oid }] } : data);
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    expect(remote.calls.some(call => call.path.includes("/git/blobs/"))).toBe(false);
  });
  it("rejects truncated provider trees", async () => {
    const { args } = input(fixture(), (call, data) => call.path.includes("/git/trees/") ? { ...(data as object), truncated: true } : data);
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it("accepts documented linewrapped Base64 without modifying blob contents", async () => {
    const f = fixture(); const { args } = input(f, (call, data) => call.path.endsWith(f.blob.oid)
      ? { ...(data as object), content: f.blob.contentBase64.match(/.{1,4}/g)!.join("\n") + "\n" } : data);
    expect((await downloadPrivateGithubRepository(args)).objects.find(item => item.oid === f.blob.oid)?.contentBase64).toBe(f.blob.contentBase64);
  });
  it.each(["not base64!?", "YQ=", "YQ== "])("rejects malformed Base64 %#", async content => {
    const f = fixture(); const { args } = input(f, (call, data) => call.path.endsWith(f.blob.oid) ? { ...(data as object), content } : data);
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it("accepts the full bounded history and rejects the next required parent without truncating", async () => {
    expect((await downloadPrivateGithubRepository(input(fixture(Buffer.from("bounded"), 16)).args)).objects.filter(item => item.type === "commit")).toHaveLength(16);
    const { args, remote } = input(fixture(Buffer.from("too long"), 17));
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    expect(remote.calls.filter(call => call.path.includes("/git/commits/"))).toHaveLength(16);
  });
  it("rejects an oversized individual source object", async () => {
    const { args } = input(fixture(Buffer.alloc(GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes + 1)));
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it("rejects aggregate object bytes before accepting an oversized repository", async () => {
    const blobs = Array.from({ length: 4 }, (_, index) => object("blob", Buffer.alloc(GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes, index)));
    const tree = object("tree", serializeGitTree(blobs.map((blob, index) => ({ name: `file${index}.bin`, mode: "100644", type: "blob", oid: blob.oid }))));
    const commit = object("commit", serializeRepositoryCommit({ tree: tree.oid, parent: null, author: PERSON, committer: PERSON, message: "Bounded\n" }));
    const f = fixture(); f.graph.head = commit.oid; f.binding.head = commit.oid; f.graph.objects = [commit, tree, ...blobs];
    await expect(downloadPrivateGithubRepository(input(f).args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it("bounds object enumeration even if each individual object is small", async () => {
    const blobs = Array.from({ length: 127 }, (_, index) => object("blob", Buffer.from(`blob${index}`)));
    const tree = object("tree", serializeGitTree(blobs.map((blob, index) => ({ name: `file${String(index).padStart(3, "0")}`, mode: "100644", type: "blob", oid: blob.oid }))));
    const commit = object("commit", serializeRepositoryCommit({ tree: tree.oid, parent: null, author: PERSON, committer: PERSON, message: "Many objects\n" }));
    const f = fixture(); f.graph.head = commit.oid; f.binding.head = commit.oid; f.graph.objects = [commit, tree, ...blobs];
    const { args, remote } = input(f);
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    expect(remote.calls.filter(call => /^\/git\/(commits|trees|blobs)\//.test(call.path))).toHaveLength(128);
  });
  it("rejects invalid owner authorization before any remote read", async () => {
    const { args, remote } = input(); args.revalidate.mockRejectedValue(new Error("revoked synthetic owner"));
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
    expect(remote.calls).toHaveLength(0);
  });
  it("stops on credential rotation without returning previously retrieved objects", async () => {
    let active = true;
    const { args, remote } = input(fixture(), (call, data) => { if (call.path.includes("/git/commits/")) active = false; return data; });
    args.revalidate.mockImplementation(async () => { if (!active) throw new Error("rotated"); });
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
    expect(remote.calls.filter(call => call.path.includes("/git/commits/"))).toHaveLength(1);
  });
  it("revalidates after the final provider response before releasing the graph", async () => {
    let active = true, refs = 0;
    const { args } = input(fixture(), (call, data) => { if (call.path === "/git/ref/heads/main" && ++refs === 2) active = false; return data; });
    args.revalidate.mockImplementation(async () => { if (!active) throw new Error("expired"); });
    await expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
  });
  it("cancels pending download without further reads or automatic retries", async () => {
    const controller = new AbortController();
    const { args, remote } = input(fixture(), (call, data) => { if (call.path.includes("/git/commits/")) controller.abort(); return data; });
    await expect(downloadPrivateGithubRepository({ ...args, signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(remote.calls).toHaveLength(3);
  });
  it("rejects an already-aborted request without provider access", async () => {
    const { args, remote } = input();
    await expect(downloadPrivateGithubRepository({ ...args, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(remote.calls).toHaveLength(0);
  });
  it("bounds disconnected provider calls without retries", async () => {
    vi.useFakeTimers(); const { args } = input();
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const pending = expect(downloadPrivateGithubRepository({ ...args, fetch: fetcher })).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(PRIVATE_GITHUB_REPOSITORY_LIMITS.requestMs + 1); await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds an unending response stream and cancels its reader", async () => {
    vi.useFakeTimers(); const { args } = input(); const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ pull() { return new Promise(() => undefined); }, cancel }),
      { headers: { "Content-Type": "application/json" } }));
    const pending = expect(downloadPrivateGithubRepository({ ...args, fetch: fetcher })).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(PRIVATE_GITHUB_REPOSITORY_LIMITS.requestMs + 1); await pending;
    expect(cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds stalled session revalidation within the aggregate duration", async () => {
    vi.useFakeTimers(); const { args, remote } = input(); args.revalidate.mockImplementation(() => new Promise(() => undefined));
    const pending = expect(downloadPrivateGithubRepository(args)).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(PRIVATE_GITHUB_REPOSITORY_LIMITS.durationMs + 1); await pending;
    expect(remote.calls).toHaveLength(0);
  });
  it.each([
    () => new Response("secret provider output", { status: 500 }),
    () => new Response("{}", { headers: { "Content-Type": "text/plain" } }),
    () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "999" } }),
    () => new Response("x".repeat(PRIVATE_GITHUB_REPOSITORY_LIMITS.responseBytes + 1), { headers: { "Content-Type": "application/json" } }),
    () => new Response(new Uint8Array([255]), { headers: { "Content-Type": "application/json" } }),
  ])("sanitizes invalid provider responses without returning contents %#", async response => {
    const { args } = input(); const fetcher = vi.fn<typeof fetch>(async () => response());
    await expect(downloadPrivateGithubRepository({ ...args, fetch: fetcher })).rejects.toEqual(new GitRepositorySourceError("PROVIDER_FAILURE"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not expose secret-bearing SDK errors, causes or response details", async () => {
    const { args } = input();
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error(`provider https://token:${TOKEN}@example.invalid secret source contents`); });
    try { await downloadPrivateGithubRepository({ ...args, fetch: fetcher }); expect.unreachable(); }
    catch (error) {
      expect(error).toBeInstanceOf(GitRepositorySourceError);
      expect(String(error)).toBe("GitRepositorySourceError: Repository source could not be verified.");
      expect(JSON.stringify(error)).not.toContain(TOKEN); expect((error as Error).cause).toBeUndefined();
    }
  });
});
