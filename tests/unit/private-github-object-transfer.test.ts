import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGitOperationScope } from "@/lib/security/git-operation-catalogue";
import { gitObjectId, serializeGitCommit, serializeGitTree, type GitTransferObjectType } from "@/lib/security/git-object-transfer";
import { executePrivateGithubObjectTransfer, PRIVATE_GITHUB_OBJECT_LIMITS } from "@/lib/workspace/private-github-object-transfer";
import { createGitObjectGithubAdapter, type SyntheticGitObject } from "../helpers/git-object-github-adapter";

const PERSON = { name: "Cr8or Studio", email: "owner@cr8or.invalid", timestamp: 1700000000, date: "2023-11-14T22:13:20.000Z" };
const TOKEN = "synthetic_private_repository_token";
function object(type: GitTransferObjectType, content: Buffer): SyntheticGitObject {
  return { oid: gitObjectId(type, content), type, contentBase64: content.toString("base64") };
}
function fixture(content = Buffer.from("exact source 😀\r\n")) {
  const baseTree = object("tree", Buffer.alloc(0));
  const base = object("commit", serializeGitCommit({ tree: baseTree.oid, parent: "a".repeat(40), author: PERSON, committer: PERSON, message: "Earlier history\n" }));
  const blob = object("blob", content);
  const tree = object("tree", serializeGitTree([{ name: "source.ts", mode: "100644", type: "blob", oid: blob.oid }]));
  const commit = object("commit", serializeGitCommit({ tree: tree.oid, parent: base.oid, author: PERSON, committer: PERSON, message: "CR8OR-001: General maintenance\n" }));
  const graph = { version: 1, repositoryKey: "badadeveloper001-dev/cr8or-studio", branch: "main", head: commit.oid, base: base.oid, objects: [commit, tree, blob] };
  const scope = buildGitOperationScope({ projectId: "registered-project", workspace: { id: "registered-workspace", runtimeType: "cloud", provider: "daytona",
    providerWorkspaceId: "registered-sandbox", repositoryUrl: `https://github.com/${graph.repositoryKey}`, branch: "main" } },
  { operation: "push", branch: "main", targetCommit: graph.head, expectedRemoteHead: graph.base });
  const remote = { repositoryKey: graph.repositoryKey, branch: graph.branch, head: graph.base, objects: [base, baseTree] };
  return { graph, scope, remote, commit, tree, blob };
}
afterEach(() => vi.useRealTimers());

describe("bounded exact-SHA GitHub object transport", () => {
  it.each([Buffer.alloc(0), Buffer.from("exact café 😀\r\n"), Buffer.from([0, 255, 128, 97])])("preserves object identities and advances only the exact approved SHA %#", async content => {
    const f = fixture(content), remote = createGitObjectGithubAdapter(f.remote), revalidate = vi.fn(async () => undefined);
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate, fetch: remote.fetcher });
    expect(result.status).toBe("SUCCEEDED"); expect(remote.head).toBe(f.graph.head);
    for (const item of f.graph.objects) expect(remote.objects.get(item.oid)).toEqual(item);
    expect(remote.mutations().map(call => call.path)).toEqual(["/git/blobs", "/git/trees", "/git/commits", "/git/refs/heads/main"]);
    expect(remote.mutations().at(-1)?.body).toEqual({ sha: f.graph.head, force: false });
    expect(revalidate.mock.calls.length).toBeGreaterThan(remote.calls.length);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    if (content.length) expect(JSON.stringify(result)).not.toContain(content.toString("base64"));
  });
  it("supports complete nested trees without base-tree merge semantics", async () => {
    const f = fixture();
    const nested = object("tree", serializeGitTree([{ name: "folder", mode: "40000", type: "tree", oid: f.tree.oid }]));
    const commit = object("commit", serializeGitCommit({ tree: nested.oid, parent: f.graph.base, author: PERSON, committer: PERSON, message: "CR8OR-001: General maintenance\n" }));
    f.graph.head = commit.oid; f.graph.objects = [commit, nested, f.tree, f.blob];
    f.scope = { ...f.scope, targetCommit: commit.oid };
    const remote = createGitObjectGithubAdapter(f.remote);
    expect((await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher })).status).toBe("SUCCEEDED");
    expect(remote.calls.filter(call => call.path === "/git/trees").every(call => !("base_tree" in (call.body as object)))).toBe(true);
  });
  it.each(["repositoryKey", "branch", "head", "base"] as const)("rejects substituted graph %s before network access", async key => {
    const f = fixture(), remote = createGitObjectGithubAdapter(f.remote); f.graph[key] = "untrusted";
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher });
    expect(result.status).toBe("FAILED"); expect(remote.calls).toHaveLength(0);
  });
  it("rejects missing or tampered objects before any remote mutation", async () => {
    const f = fixture(), remote = createGitObjectGithubAdapter(f.remote); f.graph.objects[2].contentBase64 = Buffer.from("different").toString("base64");
    expect((await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher })).status).toBe("FAILED");
    expect(remote.calls).toHaveLength(0);
  });
  it("rejects a repository-identity mismatch without sending objects", async () => {
    const f = fixture(), remote = createGitObjectGithubAdapter({ ...f.remote, afterResponse: (call, data) => call.path === "" ? { full_name: "other/repository" } : data });
    expect((await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher })).status).toBe("FAILED");
    expect(remote.mutations()).toHaveLength(0);
  });
  it("rejects changed initial remote state without mutation", async () => {
    const f = fixture(), remote = createGitObjectGithubAdapter(f.remote); remote.setHead("b".repeat(40));
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher });
    expect(result).toMatchObject({ status: "FAILED", code: "REMOTE_CHANGED" }); expect(remote.mutations()).toHaveLength(0);
  });
  it.each(["blobs", "trees", "commits"])("a wrong created %s identity remains UNKNOWN with no ref update or retry", async type => {
    const f = fixture(), remote = createGitObjectGithubAdapter({ ...f.remote,
      afterResponse: (call, data) => call.method === "POST" && call.path === `/git/${type}` ? { sha: "c".repeat(40) } : data });
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher });
    expect(result.status).toBe("UNKNOWN"); expect(remote.head).toBe(f.graph.base);
    expect(remote.mutations().filter(call => call.path === `/git/${type}`)).toHaveLength(1);
    expect(remote.calls.some(call => call.method === "PATCH")).toBe(false);
  });
  it.each(["blob", "tree", "commit"])("a tampered fetched %s is not accepted on its claimed SHA", async type => {
    const f = fixture(), target = f.graph.objects.find(item => item.type === type)!;
    const remote = createGitObjectGithubAdapter({ ...f.remote, afterResponse: (call, data) => {
      if (call.method !== "GET" || !call.path.endsWith(target.oid)) return data;
      if (type === "blob") return { ...(data as object), content: Buffer.from("tampered").toString("base64"), size: 8 };
      if (type === "tree") return { ...(data as object), tree: [] };
      return { ...(data as object), message: "changed message\n" };
    } });
    expect((await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher })).status).toBe("UNKNOWN");
    expect(remote.head).toBe(f.graph.base);
  });
  it("rejects signature evidence or provider-added headers rather than accepting a claimed commit SHA", async () => {
    const f = fixture(), remote = createGitObjectGithubAdapter({ ...f.remote,
      afterResponse: (call, data) => call.method === "GET" && call.path.endsWith(f.commit.oid) ? { ...(data as object),
        verification: { verified: true, reason: "valid", signature: "synthetic", payload: "synthetic" } } : data });
    expect((await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher })).status).toBe("UNKNOWN");
    expect(remote.head).toBe(f.graph.base);
  });
  it("accepts documented linewrapped Base64 only after exact-byte verification", async () => {
    const f = fixture(), remote = createGitObjectGithubAdapter({ ...f.remote, afterResponse: (call, data) =>
      call.method === "GET" && call.path.endsWith(f.blob.oid) ? { ...(data as object), content: f.blob.contentBase64 + "\n" } : data });
    expect((await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher })).status).toBe("SUCCEEDED");
  });
  it("rejects session revocation before any provider access", async () => {
    const f = fixture(), remote = createGitObjectGithubAdapter(f.remote);
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => { throw new Error("revoked"); }, fetch: remote.fetcher });
    expect(result).toMatchObject({ status: "FAILED", code: "AUTHORIZATION_INVALID" }); expect(remote.calls).toHaveLength(0);
  });
  it("does not release further output or perform later mutations after credential rotation", async () => {
    const f = fixture(); let valid = true;
    const remote = createGitObjectGithubAdapter({ ...f.remote, afterResponse: (call, data) => { if (call.method === "POST") valid = false; return data; } });
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => { if (!valid) throw new Error("rotated"); }, fetch: remote.fetcher });
    expect(result).toMatchObject({ status: "UNKNOWN", code: "AUTHORIZATION_INVALID" }); expect(remote.mutations()).toHaveLength(1);
    expect(result.data).toBeUndefined(); expect(remote.head).toBe(f.graph.base);
  });
  it("retains uncertainty when remote changes after object creation", async () => {
    const f = fixture();
    const remote = createGitObjectGithubAdapter({ ...f.remote, afterResponse: (call, data) => {
      if (call.method === "POST" && call.path === "/git/commits") remote.setHead("d".repeat(40)); return data;
    } });
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher });
    expect(result).toMatchObject({ status: "UNKNOWN", code: "REMOTE_CHANGED" }); expect(remote.calls.some(call => call.method === "PATCH")).toBe(false);
  });
  it("preserves the existing non-fast-forward rejection", async () => {
    const f = fixture(), remote = createGitObjectGithubAdapter(f.remote); remote.setComparison("diverged");
    expect((await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher })).status).toBe("UNKNOWN");
    expect(remote.calls.some(call => call.method === "PATCH")).toBe(false);
  });
  it("reports a lost post-update response as UNKNOWN without reversing or retrying the mutation", async () => {
    const f = fixture(), remote = createGitObjectGithubAdapter({ ...f.remote,
      afterResponse: (call, data) => { if (call.method === "PATCH") throw new Error("credential-bearing provider details"); return data; } });
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: remote.fetcher });
    expect(result.status).toBe("UNKNOWN"); expect(remote.head).toBe(f.graph.head);
    expect(remote.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("credential-bearing"); expect(result.data).toBeUndefined();
  });
  it("cancels interrupted transfer without claiming completed mutations were undone", async () => {
    const f = fixture(), controller = new AbortController();
    const remote = createGitObjectGithubAdapter({ ...f.remote, afterResponse: (call, data) => { if (call.method === "POST") controller.abort(); return data; } });
    const result = await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, signal: controller.signal, fetch: remote.fetcher });
    expect(result).toMatchObject({ status: "UNKNOWN", code: "CANCELLED", cancellationConfirmed: false });
    expect(remote.mutations()).toHaveLength(1); expect(remote.head).toBe(f.graph.base);
  });
  it("bounds a disconnected provider request", async () => {
    vi.useFakeTimers(); const f = fixture();
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const result = executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: fetcher });
    await vi.advanceTimersByTimeAsync(PRIVATE_GITHUB_OBJECT_LIMITS.requestMs + 1);
    expect(await result).toMatchObject({ status: "FAILED", code: "TIMEOUT" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized remote response bodies with sanitized results", async () => {
    const f = fixture(), fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ full_name: "x".repeat(PRIVATE_GITHUB_OBJECT_LIMITS.responseBytes) }),
      { headers: { "Content-Type": "application/json" } }));
    expect((await executePrivateGithubObjectTransfer({ ...f, token: TOKEN, revalidate: async () => undefined, fetch: fetcher }))).toMatchObject({ status: "FAILED", code: "PROVIDER_FAILURE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
