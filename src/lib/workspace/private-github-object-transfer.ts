import "server-only";

import { z } from "zod";
import { canonicalGitRepository, type GitOperationScope } from "@/lib/security/git-operation-catalogue";
import {
  GIT_OBJECT_TRANSFER_LIMITS, gitObjectId, serializeGitCommit, serializeGitTree, validateGitObjectTransfer,
  type GitTransferIdentity, type GitTransferTreeEntry, type ValidatedGitObject,
} from "@/lib/security/git-object-transfer";
import { executePrivateGithubOperation } from "@/lib/workspace/private-github-api";

export const PRIVATE_GITHUB_OBJECT_LIMITS = Object.freeze({
  durationMs: 30_000, requestMs: 5_000, requests: 300,
  responseBytes: 1024 * 1024, requestBytes: 1024 * 1024,
});
type FailureCode = "INVALID_REQUEST" | "AUTHORIZATION_INVALID" | "CANCELLED" | "TIMEOUT" | "REMOTE_CHANGED" | "PROVIDER_FAILURE";
type Receipt = { status: "SUCCEEDED" | "FAILED" | "UNKNOWN"; data?: unknown; code?: FailureCode;
  cancellationConfirmed: boolean; cleanupConfirmed: boolean };
type Input = Readonly<{ scope: GitOperationScope; graph: unknown; token: string; revalidate: () => Promise<void>;
  signal?: AbortSignal; fetch?: typeof fetch }>;
class TransferFailure extends Error {
  constructor(readonly code: FailureCode) { super("Git object transfer could not be verified."); }
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const person = z.object({ name: z.string().max(256), email: z.string().max(254), date: z.string().max(64) });
function identity(value: z.infer<typeof person>): GitTransferIdentity {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value.date)) throw new TransferFailure("PROVIDER_FAILURE");
  const timestamp = Date.parse(value.date) / 1000;
  if (!Number.isSafeInteger(timestamp)) throw new TransferFailure("PROVIDER_FAILURE");
  return { name: value.name, email: value.email, timestamp, date: new Date(timestamp * 1000).toISOString() };
}

/** Exact-object Git Database transport. This is a server-only mechanism behind
 * the unchanged release gate, opaque grant and durable mutation reservation.
 * GitHub must preserve every submitted byte: a changed SHA never substitutes
 * for the approved commit. No request is retried after an ambiguous mutation. */
export async function executePrivateGithubObjectTransfer(input: Input): Promise<Receipt> {
  const knownFailure = (code: FailureCode): Receipt => ({ status: "FAILED", code, cancellationConfirmed: true, cleanupConfirmed: true });
  let graph: ReturnType<typeof validateGitObjectTransfer>;
  try {
    graph = validateGitObjectTransfer(input.graph, input.scope);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_]{1,1024}$/.test(input.token) || typeof input.revalidate !== "function") return knownFailure("INVALID_REQUEST");
  } catch { return knownFailure("INVALID_REQUEST"); }
  const repository = canonicalGitRepository(`https://github.com/${graph.repositoryKey}`);
  const prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const endpoint = (suffix: string) => `https://api.github.com${prefix}${suffix}`;
  const branchPath = graph.branch.split("/").map(encodeURIComponent).join("/");
  const controller = new AbortController();
  let mutated = false, requests = 0, failure: TransferFailure | undefined;
  let rejectInterrupted: (error: TransferFailure) => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const interrupt = (code: FailureCode) => {
    failure ??= new TransferFailure(code); controller.abort(); rejectInterrupted(failure);
  };
  const onAbort = () => interrupt("CANCELLED");
  const timer = setTimeout(() => interrupt("TIMEOUT"), PRIVATE_GITHUB_OBJECT_LIMITS.durationMs);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const check = () => {
    if (input.signal?.aborted) interrupt("CANCELLED");
    if (failure) throw failure;
  };
  const authorize = async () => {
    check();
    try { await input.revalidate(); } catch { interrupt("AUTHORIZATION_INVALID"); }
    check();
  };
  // This wrapper also applies the same aggregate budget and deadline to the
  // existing non-force advance-branch adapter after object verification.
  const boundedFetch: typeof fetch = async (url, init) => {
    await authorize();
    const target = new URL(String(url));
    if (target.origin !== "https://api.github.com" ||
        (target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) || target.search || target.hash ||
        ++requests > PRIVATE_GITHUB_OBJECT_LIMITS.requests) throw new TransferFailure("PROVIDER_FAILURE");
    check();
    if (init?.method && init.method !== "GET") mutated = true;
    const requestTimer = setTimeout(() => interrupt("TIMEOUT"), PRIVATE_GITHUB_OBJECT_LIMITS.requestMs);
    try {
      return await Promise.race([(input.fetch ?? fetch)(url, { ...init, signal: controller.signal }), interrupted]);
    } finally { clearTimeout(requestTimer); }
  };
  const request = async (suffix: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> => {
    const wire = body === undefined ? undefined : JSON.stringify(body);
    if (wire !== undefined && Buffer.byteLength(wire) > PRIVATE_GITHUB_OBJECT_LIMITS.requestBytes) throw new TransferFailure("PROVIDER_FAILURE");
    const response = await boundedFetch(endpoint(suffix), {
      method, redirect: "error", cache: "no-store",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${input.token}`,
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Cr8or-Studio", "Content-Type": "application/json" },
      ...(wire === undefined ? {} : { body: wire }),
    });
    check();
    const declared = response.headers.get("content-length");
    if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("application/json") ||
        (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PRIVATE_GITHUB_OBJECT_LIMITS.responseBytes))) {
      void response.body?.cancel().catch(() => undefined);
      throw new TransferFailure("PROVIDER_FAILURE");
    }
    const reader = response.body.getReader();
    const buffer = new Uint8Array(PRIVATE_GITHUB_OBJECT_LIMITS.responseBytes);
    let size = 0;
    const bodyTimer = setTimeout(() => interrupt("TIMEOUT"), PRIVATE_GITHUB_OBJECT_LIMITS.requestMs);
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), interrupted]);
        check();
        if (chunk.done) break;
        if (chunk.value.byteLength > buffer.length - size) throw new TransferFailure("PROVIDER_FAILURE");
        buffer.set(chunk.value, size); size += chunk.value.byteLength;
      }
      if (declared !== null && Number(declared) !== size) throw new TransferFailure("PROVIDER_FAILURE");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))) as unknown;
    } finally {
      clearTimeout(bodyTimer); void reader.cancel().catch(() => undefined);
      try { reader.releaseLock(); } catch { /* An interrupted reader can still own its pending read. */ }
    }
  };
  const requireHead = async () => {
    const ref = z.object({ ref: z.literal(`refs/heads/${graph.branch}`), object: z.object({ type: z.literal("commit"), sha }) })
      .parse(await request(`/git/ref/heads/${branchPath}`));
    if (ref.object.sha !== graph.base) throw new TransferFailure("REMOTE_CHANGED");
  };
  const verify = async (object: ValidatedGitObject) => {
    const data = await request(`/git/${object.type === "blob" ? "blobs" : object.type === "tree" ? "trees" : "commits"}/${object.oid}`);
    let raw: Buffer;
    if (object.type === "blob") {
      const result = z.object({ sha: z.literal(object.oid), encoding: z.literal("base64"),
        size: z.number().int().nonnegative().max(GIT_OBJECT_TRANSFER_LIMITS.objectBytes), content: z.string().max(PRIVATE_GITHUB_OBJECT_LIMITS.responseBytes) }).parse(data);
      // GitHub wraps returned Base64 in newlines. No other whitespace or
      // noncanonical encoding may hide a different payload.
      const encoded = result.content.replace(/\n/g, "");
      raw = Buffer.from(encoded, "base64");
      if (raw.toString("base64") !== encoded || raw.length !== result.size) throw new TransferFailure("PROVIDER_FAILURE");
    } else if (object.type === "tree") {
      const result = z.object({ sha: z.literal(object.oid), truncated: z.literal(false), tree: z.array(z.object({
        path: z.string().max(4096), mode: z.enum(["100644", "100755", "040000"]), type: z.enum(["blob", "tree"]), sha,
      })).max(GIT_OBJECT_TRANSFER_LIMITS.treeEntries) }).parse(data);
      const entries: GitTransferTreeEntry[] = result.tree.map(entry => ({ name: entry.path,
        mode: entry.mode === "040000" ? "40000" : entry.mode, type: entry.type, oid: entry.sha }));
      raw = serializeGitTree(entries);
    } else {
      const result = z.object({ sha: z.literal(object.oid), tree: z.object({ sha }), parents: z.array(z.object({ sha })).length(1),
        author: person, committer: person, message: z.string().max(GIT_OBJECT_TRANSFER_LIMITS.objectBytes),
        verification: z.object({ verified: z.literal(false), reason: z.literal("unsigned"), signature: z.null(), payload: z.null() }),
      }).parse(data);
      raw = serializeGitCommit({ tree: result.tree.sha, parent: result.parents[0].sha,
        author: identity(result.author), committer: identity(result.committer), message: result.message });
    }
    if (!raw.equals(object.content) || gitObjectId(object.type, raw) !== object.oid) throw new TransferFailure("PROVIDER_FAILURE");
  };
  const uploaded = new Set<string>();
  const upload = async (object: ValidatedGitObject): Promise<void> => {
    if (uploaded.has(object.oid)) return;
    if (object.type === "tree") for (const entry of object.entries) await upload(graph.objects.get(entry.oid)!);
    const route = object.type === "blob" ? "blobs" : object.type === "tree" ? "trees" : "commits";
    const actor = (value: GitTransferIdentity) => ({ name: value.name, email: value.email, date: value.date.replace(".000Z", "Z") });
    const body = object.type === "blob" ? { encoding: "base64", content: object.content.toString("base64") } : object.type === "tree" ? {
      tree: object.entries.map(entry => ({ path: entry.name, mode: entry.mode === "40000" ? "040000" : entry.mode, type: entry.type, sha: entry.oid })),
    } : { tree: object.tree, parents: [object.parent], author: actor(object.author), committer: actor(object.committer), message: object.message };
    z.object({ sha: z.literal(object.oid) }).parse(await request(`/git/${route}`, "POST", body));
    await verify(object);
    uploaded.add(object.oid);
  };
  const perform = async (): Promise<Receipt> => {
    const metadata = z.object({ full_name: z.string().max(256) }).parse(await request(""));
    if (metadata.full_name.toLowerCase() !== graph.repositoryKey) throw new TransferFailure("PROVIDER_FAILURE");
    await requireHead();
    // The already registered remote branch's commit is the only external
    // ancestry anchor. Its historic format is not reconstructed or rewritten.
    z.object({ sha: z.literal(graph.base) }).parse(await request(`/git/commits/${graph.base}`));
    for (const commit of graph.commits) {
      await upload(graph.objects.get(commit.tree)!);
      await upload(commit);
    }
    await requireHead();
    await authorize();
    const result = await executePrivateGithubOperation({ repository: { owner: repository.owner, repo: repository.repo },
      operation: { kind: "advance-branch", branch: graph.branch, expectedHead: graph.base, targetCommit: graph.head },
      token: input.token, revalidate: authorize, signal: controller.signal, fetch: boundedFetch });
    if (result.status !== "SUCCEEDED") throw new TransferFailure(result.code ?? "PROVIDER_FAILURE");
    await authorize();
    return { status: "SUCCEEDED", data: result.data, cancellationConfirmed: true, cleanupConfirmed: true };
  };
  try {
    return await Promise.race([perform(), interrupted]);
  } catch (error) {
    const code = failure?.code ?? (error instanceof TransferFailure ? error.code : "PROVIDER_FAILURE");
    return { status: mutated ? "UNKNOWN" : "FAILED", code, cancellationConfirmed: !mutated, cleanupConfirmed: !mutated };
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); controller.abort();
  }
}
