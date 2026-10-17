import "server-only";

import { z } from "zod";
import { canonicalGitRepository, validGitRef } from "@/lib/security/git-operation-catalogue";
import { gitObjectId, serializeGitTree, type GitTransferIdentity, type GitTransferObjectType } from "@/lib/security/git-object-transfer";
import {
  GIT_REPOSITORY_INITIALIZATION_LIMITS, serializeRepositoryCommit, validateRepositoryInitialization,
} from "@/lib/security/git-repository-initialization";

export const PRIVATE_GITHUB_REPOSITORY_LIMITS = Object.freeze({
  durationMs: 30_000, requestMs: 5_000, requests: 300, responseBytes: 1024 * 1024,
});
export type GitRepositorySourceFailure = "INVALID_REQUEST" | "AUTHORIZATION_INVALID" | "CANCELLED" | "TIMEOUT" | "REMOTE_CHANGED" | "PROVIDER_FAILURE";
export class GitRepositorySourceError extends Error {
  constructor(readonly code: GitRepositorySourceFailure) {
    super("Repository source could not be verified."); this.name = "GitRepositorySourceError";
  }
}
type SourceInput = Readonly<{ repositoryKey: string; branch: string; token: string; revalidate: () => Promise<void>;
  signal?: AbortSignal; fetch?: typeof fetch }>;
type SourceObject = Readonly<{ oid: string; type: GitTransferObjectType; contentBase64: string }>;
export type GithubRepositoryGraph = Readonly<{ version: 1; repositoryKey: string; branch: string; head: string; objects: readonly SourceObject[] }>;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const person = z.object({ name: z.string().max(256), email: z.string().max(254), date: z.string().max(64) });
const treeSchema = z.object({ sha, truncated: z.literal(false), tree: z.array(z.object({
  path: z.string().max(4096), mode: z.enum(["100644", "100755", "040000"]), type: z.enum(["blob", "tree"]), sha,
})).max(GIT_REPOSITORY_INITIALIZATION_LIMITS.treeEntries) });
const commitSchema = z.object({ sha, tree: z.object({ sha }), parents: z.array(z.object({ sha })).max(1),
  author: person, committer: person, message: z.string().max(GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes),
  verification: z.object({ verified: z.literal(false), reason: z.literal("unsigned"), signature: z.null(), payload: z.null() }),
});
function identity(value: z.infer<typeof person>): GitTransferIdentity {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value.date)) throw new GitRepositorySourceError("PROVIDER_FAILURE");
  const timestamp = Date.parse(value.date) / 1000;
  if (!Number.isSafeInteger(timestamp)) throw new GitRepositorySourceError("PROVIDER_FAILURE");
  return { name: value.name, email: value.email, timestamp, date: new Date(timestamp * 1000).toISOString() };
}
type SourceTransport = { request: (suffix: string) => Promise<unknown>; authorize: () => Promise<void>; head: () => Promise<string> };

/** Read-only, server-mediated Git Database transport. Callers independently
 * establish the lifecycle capability; this pure source mechanism grants none.
 * Credentials go only to the canonical HTTPS API origin, never into the graph. */
async function withSource<T>(input: SourceInput, work: (source: SourceTransport) => Promise<T>): Promise<T> {
  let prefix: string;
  try {
    const repository = canonicalGitRepository(`https://github.com/${input.repositoryKey}`);
    if (repository.key !== input.repositoryKey || !validGitRef(input.branch) || typeof input.token !== "string" ||
        !/^[A-Za-z0-9_]{1,1024}$/.test(input.token) || typeof input.revalidate !== "function") throw new Error();
    prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  } catch { throw new GitRepositorySourceError("INVALID_REQUEST"); }
  const controller = new AbortController();
  let requests = 0, failure: GitRepositorySourceError | undefined;
  let rejectInterrupted: (error: GitRepositorySourceError) => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const interrupt = (code: GitRepositorySourceFailure) => {
    failure ??= new GitRepositorySourceError(code); controller.abort(); rejectInterrupted(failure);
  };
  const onAbort = () => interrupt("CANCELLED");
  const timer = setTimeout(() => interrupt("TIMEOUT"), PRIVATE_GITHUB_REPOSITORY_LIMITS.durationMs);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const check = () => {
    if (input.signal?.aborted) interrupt("CANCELLED");
    if (failure) throw failure;
  };
  const authorize = async () => {
    check();
    try { await Promise.race([input.revalidate(), interrupted]); }
    catch { if (!failure) interrupt("AUTHORIZATION_INVALID"); }
    check();
  };
  const request = async (suffix: string): Promise<unknown> => {
    await authorize();
    if (++requests > PRIVATE_GITHUB_REPOSITORY_LIMITS.requests) throw new GitRepositorySourceError("PROVIDER_FAILURE");
    const requestTimer = setTimeout(() => interrupt("TIMEOUT"), PRIVATE_GITHUB_REPOSITORY_LIMITS.requestMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([(input.fetch ?? fetch)(`https://api.github.com${prefix}${suffix}`, {
        method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${input.token}`,
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Cr8or-Studio" },
      }), interrupted]);
      check();
      const declared = response.headers.get("content-length");
      if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("application/json") ||
          (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PRIVATE_GITHUB_REPOSITORY_LIMITS.responseBytes))) {
        void response.body?.cancel().catch(() => undefined);
        throw new GitRepositorySourceError("PROVIDER_FAILURE");
      }
      reader = response.body.getReader();
      const buffer = new Uint8Array(PRIVATE_GITHUB_REPOSITORY_LIMITS.responseBytes);
      let size = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), interrupted]);
        check();
        if (chunk.done) break;
        if (chunk.value.byteLength > buffer.length - size) throw new GitRepositorySourceError("PROVIDER_FAILURE");
        buffer.set(chunk.value, size); size += chunk.value.byteLength;
      }
      if (declared !== null && Number(declared) !== size) throw new GitRepositorySourceError("PROVIDER_FAILURE");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))) as unknown;
    } finally {
      clearTimeout(requestTimer); void reader?.cancel().catch(() => undefined);
      try { reader?.releaseLock(); } catch { /* The aborted read can still be pending. */ }
    }
  };
  const head = async () => z.object({ ref: z.literal(`refs/heads/${input.branch}`), object: z.object({ type: z.literal("commit"), sha }) })
    .parse(await request(`/git/ref/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`)).object.sha;
  const perform = async () => {
    const repository = z.object({ full_name: z.string().max(256) }).parse(await request(""));
    if (repository.full_name.toLowerCase() !== input.repositoryKey) throw new GitRepositorySourceError("PROVIDER_FAILURE");
    const result = await work({ request, authorize, head });
    await authorize();
    return result;
  };
  try { return await Promise.race([perform(), interrupted]); }
  catch (error) { throw failure ?? (error instanceof GitRepositorySourceError ? error : new GitRepositorySourceError("PROVIDER_FAILURE")); }
  finally { clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); controller.abort(); }
}

/** Resolve approval data from the canonical repository, never a caller's SHA. */
export async function resolvePrivateGithubRepositoryHead(input: SourceInput): Promise<string> {
  return withSource(input, async source => {
    const head = await source.head();
    if (await source.head() !== head) throw new GitRepositorySourceError("REMOTE_CHANGED");
    return head;
  });
}

/** Download the complete supported branch ancestry through its real root. A
 * partial graph, API-normalized commit identity or unsupported object is denied;
 * an archive, shallow history or replacement commit is never substituted. */
export async function downloadPrivateGithubRepository(input: SourceInput & Readonly<{ head: string }>): Promise<GithubRepositoryGraph> {
  if (!sha.safeParse(input.head).success) throw new GitRepositorySourceError("INVALID_REQUEST");
  return withSource(input, async source => {
    const requireHead = async () => {
      if (await source.head() !== input.head) throw new GitRepositorySourceError("REMOTE_CHANGED");
    };
    await requireHead();
    const objects = new Map<string, SourceObject>();
    const trees = new Set<string>();
    let totalBytes = 0, treeEntries = 0, commitCount = 0;
    const store = (oid: string, type: GitTransferObjectType, raw: Buffer) => {
      if (objects.has(oid) || objects.size >= GIT_REPOSITORY_INITIALIZATION_LIMITS.objects ||
          raw.length > GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes ||
          (totalBytes += raw.length) > GIT_REPOSITORY_INITIALIZATION_LIMITS.totalBytes || gitObjectId(type, raw) !== oid) {
        throw new GitRepositorySourceError("PROVIDER_FAILURE");
      }
      objects.set(oid, Object.freeze({ oid, type, contentBase64: raw.toString("base64") }));
    };
    let cursor: string | null = input.head;
    while (cursor !== null) {
      if (++commitCount > GIT_REPOSITORY_INITIALIZATION_LIMITS.commits || objects.has(cursor)) throw new GitRepositorySourceError("PROVIDER_FAILURE");
      const commit = commitSchema.parse(await source.request(`/git/commits/${cursor}`));
      if (commit.sha !== cursor) throw new GitRepositorySourceError("PROVIDER_FAILURE");
      const parent = commit.parents[0]?.sha ?? null;
      store(cursor, "commit", serializeRepositoryCommit({ tree: commit.tree.sha, parent,
        author: identity(commit.author), committer: identity(commit.committer), message: commit.message }));
      trees.add(commit.tree.sha);
      cursor = parent;
    }
    const downloadTree = async (oid: string, depth: number): Promise<void> => {
      if (depth > GIT_REPOSITORY_INITIALIZATION_LIMITS.depth) throw new GitRepositorySourceError("PROVIDER_FAILURE");
      if (objects.has(oid)) {
        if (objects.get(oid)?.type !== "tree") throw new GitRepositorySourceError("PROVIDER_FAILURE");
        return;
      }
      if (objects.size >= GIT_REPOSITORY_INITIALIZATION_LIMITS.objects) throw new GitRepositorySourceError("PROVIDER_FAILURE");
      const tree = treeSchema.parse(await source.request(`/git/trees/${oid}`));
      if (tree.sha !== oid || (treeEntries += tree.tree.length) > GIT_REPOSITORY_INITIALIZATION_LIMITS.treeEntries) throw new GitRepositorySourceError("PROVIDER_FAILURE");
      store(oid, "tree", serializeGitTree(tree.tree.map(entry => ({ name: entry.path,
        mode: entry.mode === "040000" ? "40000" : entry.mode, type: entry.type, oid: entry.sha }))));
      for (const entry of tree.tree) {
        if (entry.type === "tree") await downloadTree(entry.sha, depth + 1);
        else if (objects.has(entry.sha)) {
          if (objects.get(entry.sha)?.type !== "blob") throw new GitRepositorySourceError("PROVIDER_FAILURE");
        } else {
          if (objects.size >= GIT_REPOSITORY_INITIALIZATION_LIMITS.objects) throw new GitRepositorySourceError("PROVIDER_FAILURE");
          const blob = z.object({ sha: z.literal(entry.sha), encoding: z.literal("base64"),
            size: z.number().int().nonnegative().max(GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes),
            content: z.string().max(PRIVATE_GITHUB_REPOSITORY_LIMITS.responseBytes) }).parse(await source.request(`/git/blobs/${entry.sha}`));
          const encoded = blob.content.replace(/\n/g, ""), raw = Buffer.from(encoded, "base64");
          if (raw.toString("base64") !== encoded || raw.length !== blob.size) throw new GitRepositorySourceError("PROVIDER_FAILURE");
          store(entry.sha, "blob", raw);
        }
      }
    };
    for (const oid of trees) await downloadTree(oid, 0);
    const graph: GithubRepositoryGraph = Object.freeze({ version: 1, repositoryKey: input.repositoryKey, branch: input.branch,
      head: input.head, objects: Object.freeze([...objects.values()]) });
    validateRepositoryInitialization(graph, { repositoryKey: input.repositoryKey, branch: input.branch, head: input.head });
    await requireHead();
    return graph;
  });
}
