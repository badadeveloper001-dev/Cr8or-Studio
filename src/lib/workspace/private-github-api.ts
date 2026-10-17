import "server-only";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { formatGitPullTitle, GIT_PULL_CATEGORIES, resolveGitProjectCode } from "@/lib/security/git-project-naming";

/** Low-level transport. Callers must obtain a trusted Git grant and enforce the release gate first. */
export const PRIVATE_GITHUB_LIMITS = Object.freeze({
  durationMs: 30_000,
  responseBytes: 1024 * 1024,
  fileBytes: 256 * 1024,
  pathBytes: 4096,
  items: 100,
  sequenceRefs: 32,
  sequenceCommits: 1000,
});

const name = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const branch = z.string().min(1).max(255).refine((value) =>
  !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") &&
  !/[\s\x00-\x1f\x7f~^:?*\\[\]]/.test(value) && !value.includes("..") &&
  !value.includes("@{") && value !== "@" && !value.split("/").some((part) =>
    !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")));
const relativePath = z.string().min(1).refine((value) => {
  if (Buffer.byteLength(value, "utf8") > PRIVATE_GITHUB_LIMITS.pathBytes || /[\x00-\x1f\x7f\\]/.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("-") &&
    !/^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|credentials(?:\..*)?)$/i.test(part));
});
const commitMessage = z.string().regex(/^PROJECT-[0-9]{3,9}: (General maintenance|Code improvements|Documentation updates|Test improvements|Configuration updates)$/);
const utf8Content = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= PRIVATE_GITHUB_LIMITS.fileBytes &&
  Buffer.from(value, "utf8").toString("utf8") === value);
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("metadata") }).strict(),
  z.object({ kind: z.literal("branches") }).strict(),
  z.object({ kind: z.literal("pr-checks"), branch, pullNumber: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("commits"), branch }).strict(),
  z.object({ kind: z.literal("commit-sequence"), branch, expectedHead: sha }).strict(),
  z.object({ kind: z.literal("contents"), branch, path: relativePath.optional() }).strict(),
  z.object({ kind: z.literal("read-file"), branch, path: relativePath }).strict(),
  z.object({ kind: z.literal("create-branch"), branch, fromBranch: branch, expectedHead: sha }).strict(),
  z.object({ kind: z.literal("create-pr"), branch, base: branch, expectedHead: sha, expectedBase: sha,
    category: z.enum(GIT_PULL_CATEGORIES),
    body: z.string().max(16_384) }).strict(),
  z.object({ kind: z.literal("update-file"), branch, expectedHead: sha, path: relativePath,
    expectedFileSha: sha.nullable(), content: utf8Content, message: commitMessage }).strict(),
  z.object({ kind: z.literal("advance-branch"), branch, expectedHead: sha, targetCommit: sha }).strict(),
]);
export type PrivateGithubOperation = z.infer<typeof operationSchema>;
export type PrivateGithubReceipt = Readonly<{
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  data?: unknown;
  code?: "INVALID_REQUEST" | "AUTHORIZATION_INVALID" | "CANCELLED" | "TIMEOUT" | "REMOTE_CHANGED" | "PROVIDER_FAILURE";
}>;
export type PrivateGithubInput = Readonly<{
  repository: Readonly<{ owner: string; repo: string }>;
  operation: PrivateGithubOperation;
  /** Trusted server credential only; never serialized into a scope, grant, receipt or command. */
  token: string;
  revalidate: () => Promise<void>;
  signal?: AbortSignal;
  /** Controlled adapters in isolated tests; application integration uses native fetch. */
  fetch?: typeof fetch;
}>;

class TransportFailure extends Error {
  constructor(readonly code: NonNullable<PrivateGithubReceipt["code"]>) { super("GitHub operation could not be verified."); }
}
const refSchema = z.object({ ref: z.string(), object: z.object({ type: z.literal("commit"), sha }) });
const commitSchema = z.object({ sha, parents: z.array(z.object({ sha })).max(100) });
const contentSchema = z.object({ type: z.enum(["file", "dir"]), name: z.string().max(255), path: relativePath, sha });

/** No retries: after any mutation dispatch, an unverifiable outcome is UNKNOWN. */
export async function executePrivateGithubOperation(input: PrivateGithubInput): Promise<PrivateGithubReceipt> {
  const parsedRepository = z.object({ owner: name, repo: name }).strict().safeParse(input.repository);
  const parsedOperation = operationSchema.safeParse(input.operation);
  if (!parsedRepository.success || !parsedOperation.success || typeof input.token !== "string" ||
    !/^[A-Za-z0-9_]{1,1024}$/.test(input.token) || typeof input.revalidate !== "function") {
    return { status: "FAILED", code: "INVALID_REQUEST" };
  }
  const repository = parsedRepository.data;
  const operation = parsedOperation.data;
  const repositoryKey = `${repository.owner}/${repository.repo}`.toLowerCase();
  let projectCode: string | undefined;
  if (operation.kind === "create-pr") {
    try { projectCode = resolveGitProjectCode(repositoryKey); } catch { return { status: "FAILED", code: "INVALID_REQUEST" }; }
  }
  const repoPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const endpoint = (suffix: string) => `https://api.github.com${repoPath}${suffix}`;
  const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  const controller = new AbortController();
  const deadline = performance.now() + PRIVATE_GITHUB_LIMITS.durationMs;
  let failure: TransportFailure | undefined;
  let dispatchedMutation = false;
  let rejectInterruption: (error: TransportFailure) => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => { rejectInterruption = reject; });
  const interrupt = (code: NonNullable<PrivateGithubReceipt["code"]>) => {
    failure ??= new TransportFailure(code);
    controller.abort();
    rejectInterruption(failure);
  };
  const onAbort = () => interrupt("CANCELLED");
  const timer = setTimeout(() => interrupt("TIMEOUT"), PRIVATE_GITHUB_LIMITS.durationMs);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const check = () => {
    if (input.signal?.aborted) interrupt("CANCELLED");
    if (performance.now() >= deadline) interrupt("TIMEOUT");
    if (failure) throw failure;
  };
  const authorize = async () => {
    check();
    try { await input.revalidate(); } catch { interrupt("AUTHORIZATION_INVALID"); }
    check();
  };
  const request = async (suffix: string, method: "GET" | "POST" | "PUT" | "PATCH" = "GET", body?: unknown,
    missingAllowed = false, completePage = false): Promise<unknown> => {
    await authorize();
    check();
    if (method !== "GET") dispatchedMutation = true;
    const response = await (input.fetch ?? fetch)(endpoint(suffix), {
      method, redirect: "error", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${input.token}`,
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Cr8or-Studio", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    check();
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404 && missingAllowed) return null;
      throw new TransportFailure("PROVIDER_FAILURE");
    }
    if (completePage && response.headers.has("link")) {
      void response.body?.cancel().catch(() => undefined);
      throw new TransportFailure("PROVIDER_FAILURE");
    }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > PRIVATE_GITHUB_LIMITS.responseBytes)) {
      void response.body?.cancel().catch(() => undefined);
      throw new TransportFailure("PROVIDER_FAILURE");
    }
    if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      void response.body?.cancel().catch(() => undefined);
      throw new TransportFailure("PROVIDER_FAILURE");
    }
    const reader = response.body.getReader();
    const buffer = new Uint8Array(PRIVATE_GITHUB_LIMITS.responseBytes);
    let size = 0;
    try {
      while (true) {
        check();
        const chunk = await reader.read();
        check();
        if (chunk.done) break;
        if (chunk.value.byteLength > buffer.length - size) throw new TransportFailure("PROVIDER_FAILURE");
        buffer.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
      if (declared && Number(declared) !== size) throw new TransportFailure("PROVIDER_FAILURE");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))) as unknown;
    } finally {
      void reader.cancel().catch(() => undefined);
      try { reader.releaseLock(); } catch { /* A cancelled pending read may still own the stream. */ }
    }
  };
  const getRef = async (target: string) => {
    const ref = refSchema.parse(await request(`/git/ref/heads/${encodePath(target)}`));
    if (ref.ref !== `refs/heads/${target}`) throw new TransportFailure("PROVIDER_FAILURE");
    return ref.object.sha;
  };
  const requireHead = async (target: string, expected: string) => {
    if (await getRef(target) !== expected) throw new TransportFailure("REMOTE_CHANGED");
  };
  const readContent = (path: string, target: string, missingAllowed = false) =>
    request(`/contents/${encodePath(path)}?ref=${encodeURIComponent(target)}`, "GET", undefined, missingAllowed);
  const safePull = (value: unknown, title: string, expectedNumber?: number) => {
    const pull = z.object({ number: z.number().int().positive(), state: z.literal("open"), draft: z.literal(true), title: z.literal(title),
      head: z.object({ ref: branch, sha, repo: z.object({ full_name: z.string() }) }),
      base: z.object({ ref: branch, sha, repo: z.object({ full_name: z.string() }) }) }).parse(value);
    if (operation.kind !== "create-pr" || pull.head.repo.full_name.toLowerCase() !== repositoryKey ||
      pull.base.repo.full_name.toLowerCase() !== repositoryKey || pull.head.ref !== operation.branch || pull.base.ref !== operation.base ||
      pull.head.sha !== operation.expectedHead || pull.base.sha !== operation.expectedBase ||
      (expectedNumber !== undefined && pull.number !== expectedNumber)) throw new TransportFailure("PROVIDER_FAILURE");
    return pull;
  };
  const listCompleteRefs = async (expected: ReadonlyArray<{ branch: string; head: string }>) => {
    const refs = z.array(z.object({ name: branch, commit: z.object({ sha }) })).max(PRIVATE_GITHUB_LIMITS.items);
    const branches = refs.parse(await request("/branches?per_page=100", "GET", undefined, false, true));
    const tags = refs.parse(await request("/tags?per_page=100", "GET", undefined, false, true));
    // A full page is not proof of completeness. Never number from partial history.
    if (branches.length >= PRIVATE_GITHUB_LIMITS.items || tags.length >= PRIVATE_GITHUB_LIMITS.items ||
      branches.length + tags.length > PRIVATE_GITHUB_LIMITS.sequenceRefs) throw new TransportFailure("PROVIDER_FAILURE");
    const all = [...branches.map((item) => ({ kind: "branch", name: item.name, sha: item.commit.sha })),
      ...tags.map((item) => ({ kind: "tag", name: item.name, sha: item.commit.sha }))]
      .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
    if (new Set(all.map((item) => `${item.kind}:${item.name}`)).size !== all.length) throw new TransportFailure("PROVIDER_FAILURE");
    if (expected.some((item) => branches.find((candidate) => candidate.name === item.branch)?.commit.sha !== item.head)) {
      throw new TransportFailure("REMOTE_CHANGED");
    }
    return all;
  };
  const completeHistory = async (tip: string) => {
    const history = z.array(z.object({ sha, commit: z.object({ message: z.string().max(16_384) }) })).max(PRIVATE_GITHUB_LIMITS.items)
      .parse(await request(`/commits?sha=${tip}&per_page=100`, "GET", undefined, false, true));
    if (history.length === 0 || history.length >= PRIVATE_GITHUB_LIMITS.items || history[0].sha !== tip ||
      new Set(history.map((item) => item.sha)).size !== history.length) throw new TransportFailure("PROVIDER_FAILURE");
    return history;
  };
  const titleSequence = (title: string, code: string) => {
    // code is server-owned (or the existing fixed PROJECT commit namespace).
    const match = new RegExp(`^${code}-([0-9]{3,}): `).exec(title);
    if (!match) return 0;
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value > 999_999_999) throw new TransportFailure("PROVIDER_FAILURE");
    return value;
  };
  const scanHistorySequences = async (refs: ReadonlyArray<{ sha: string }>, code: string,
    known?: Awaited<ReturnType<typeof completeHistory>>) => {
    const seen = new Set<string>();
    let sequence = 0;
    for (const tip of new Set(refs.map((item) => item.sha))) {
      const history = known?.[0].sha === tip ? known : await completeHistory(tip);
      for (const commit of history) {
        if (seen.has(commit.sha)) continue;
        seen.add(commit.sha);
        if (seen.size > PRIVATE_GITHUB_LIMITS.sequenceCommits) throw new TransportFailure("PROVIDER_FAILURE");
        sequence = Math.max(sequence, titleSequence(commit.commit.message, code));
      }
    }
    return sequence;
  };
  const listCompletePulls = async () => {
    const items = z.array(z.object({ number: z.number().int().positive(), title: z.string().max(1024),
      base: z.object({ repo: z.object({ full_name: z.string() }) }) })).max(PRIVATE_GITHUB_LIMITS.items)
      .parse(await request("/pulls?state=all&per_page=100", "GET", undefined, false, true));
    if (items.length >= PRIVATE_GITHUB_LIMITS.items || new Set(items.map((item) => item.number)).size !== items.length ||
      items.some((item) => item.base.repo.full_name.toLowerCase() !== repositoryKey)) throw new TransportFailure("PROVIDER_FAILURE");
    // Keep only the numbering snapshot: provider URLs and unrelated PR bodies are never trusted or returned.
    return items.map((item) => ({ number: item.number, title: item.title })).sort((left, right) => left.number - right.number);
  };
  const perform = async (): Promise<unknown> => {
    if (operation.kind === "metadata") {
      const remote = z.object({ full_name: z.string(), private: z.boolean(), default_branch: branch }).parse(await request(""));
      if (remote.full_name.toLowerCase() !== `${repository.owner}/${repository.repo}`.toLowerCase()) throw new TransportFailure("PROVIDER_FAILURE");
      return { owner: repository.owner, repo: repository.repo, private: remote.private, defaultBranch: remote.default_branch,
        url: `https://github.com/${repository.owner}/${repository.repo}` };
    }
    if (operation.kind === "branches") {
      const items = z.array(z.object({ name: branch, commit: z.object({ sha }) })).max(PRIVATE_GITHUB_LIMITS.items)
        .parse(await request("/branches?per_page=100"));
      return { branches: items.map((item) => ({ name: item.name, sha: item.commit.sha })), possiblyIncomplete: items.length === PRIVATE_GITHUB_LIMITS.items };
    }
    if (operation.kind === "commits") {
      const items = z.array(z.object({ sha, commit: z.object({ message: z.string().max(16_384) }) })).max(PRIVATE_GITHUB_LIMITS.items)
        .parse(await request(`/commits?sha=${encodeURIComponent(operation.branch)}&per_page=100`));
      return { commits: items.map((item) => {
        const match = /^PROJECT-([0-9]{3,}): /.exec(item.commit.message);
        const sequence = match ? Number(match[1]) : null;
        if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence > 999_999_999)) throw new TransportFailure("PROVIDER_FAILURE");
        return { sha: item.sha, sequence };
      }), complete: items.length < PRIVATE_GITHUB_LIMITS.items };
    }
    if (operation.kind === "commit-sequence") {
      const expected = [{ branch: operation.branch, head: operation.expectedHead }];
      const initialRefs = await listCompleteRefs(expected);
      const sequence = await scanHistorySequences(initialRefs, "PROJECT");
      if (sequence >= 999_999_999) throw new TransportFailure("PROVIDER_FAILURE");
      if (JSON.stringify(await listCompleteRefs(expected)) !== JSON.stringify(initialRefs)) throw new TransportFailure("REMOTE_CHANGED");
      return { head: operation.expectedHead, nextSequence: sequence + 1 };
    }
    if (operation.kind === "contents") {
      const result = await readContent(operation.path ?? "", operation.branch);
      const items = z.array(contentSchema).max(PRIVATE_GITHUB_LIMITS.items).parse(Array.isArray(result) ? result : [result]);
      const prefix = operation.path ? `${operation.path}/` : "";
      if (items.some((item) => item.path !== operation.path && !item.path.startsWith(prefix))) throw new TransportFailure("PROVIDER_FAILURE");
      return { items, possiblyIncomplete: items.length === PRIVATE_GITHUB_LIMITS.items };
    }
    if (operation.kind === "read-file") {
      const file = z.object({ type: z.literal("file"), path: relativePath, sha, encoding: z.literal("base64"),
        size: z.number().int().min(0).max(PRIVATE_GITHUB_LIMITS.fileBytes), content: z.string().max(400_000) }).parse(await readContent(operation.path, operation.branch));
      const encoded = file.content.replace(/\n/g, "");
      if (file.path !== operation.path || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new TransportFailure("PROVIDER_FAILURE");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== file.size || bytes.toString("base64") !== encoded) throw new TransportFailure("PROVIDER_FAILURE");
      return { path: file.path, sha: file.sha, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    }
    if (operation.kind === "pr-checks") {
      const pull = z.object({ number: z.literal(operation.pullNumber), state: z.enum(["open", "closed"]),
        head: z.object({ ref: branch, sha, repo: z.object({ full_name: z.string() }) }),
        base: z.object({ repo: z.object({ full_name: z.string() }) }) }).parse(await request(`/pulls/${operation.pullNumber}`));
      const fullName = `${repository.owner}/${repository.repo}`.toLowerCase();
      if (pull.head.ref !== operation.branch || pull.head.repo.full_name.toLowerCase() !== fullName ||
        pull.base.repo.full_name.toLowerCase() !== fullName) throw new TransportFailure("PROVIDER_FAILURE");
      const checks = z.object({ total_count: z.number().int().min(0), check_runs: z.array(z.object({
        name: z.string().max(200), status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
        conclusion: z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]).nullable(),
      })).max(PRIVATE_GITHUB_LIMITS.items) }).parse(await request(`/commits/${pull.head.sha}/check-runs?per_page=100`));
      return { pullNumber: pull.number, state: pull.state, head: pull.head.sha, checkRuns: checks.check_runs,
        possiblyIncomplete: checks.total_count > checks.check_runs.length };
    }
    await requireHead(operation.kind === "create-branch" ? operation.fromBranch : operation.branch, operation.expectedHead);
    if (operation.kind === "create-branch") {
      const created = refSchema.parse(await request("/git/refs", "POST", { ref: `refs/heads/${operation.branch}`, sha: operation.expectedHead }));
      if (created.ref !== `refs/heads/${operation.branch}` || created.object.sha !== operation.expectedHead) throw new TransportFailure("PROVIDER_FAILURE");
      await requireHead(operation.branch, operation.expectedHead);
      return { branch: operation.branch, head: operation.expectedHead };
    }
    if (operation.kind === "create-pr") {
      if (operation.branch === operation.base || !projectCode) throw new TransportFailure("INVALID_REQUEST");
      // The approved immutable head and category determine one title. A stale candidate
      // fails; mutable state must never silently select a different approved title.
      const code = projectCode;
      const approvedHistory = await completeHistory(operation.expectedHead);
      const nextSequence = 1 + Math.max(0, ...approvedHistory.map((item) => titleSequence(item.commit.message, code)));
      const title = formatGitPullTitle(code, nextSequence, operation.category);
      const expected = [{ branch: operation.branch, head: operation.expectedHead }, { branch: operation.base, head: operation.expectedBase }];
      const initialRefs = await listCompleteRefs(expected);
      if (await scanHistorySequences(initialRefs, code, approvedHistory) >= nextSequence) throw new TransportFailure("REMOTE_CHANGED");
      const initialPulls = await listCompletePulls();
      if (initialPulls.some((item) => titleSequence(item.title, code) >= nextSequence)) throw new TransportFailure("REMOTE_CHANGED");
      if (JSON.stringify(await listCompleteRefs(expected)) !== JSON.stringify(initialRefs) ||
        JSON.stringify(await listCompletePulls()) !== JSON.stringify(initialPulls)) throw new TransportFailure("REMOTE_CHANGED");
      await requireHead(operation.base, operation.expectedBase);
      await requireHead(operation.branch, operation.expectedHead);
      const created = safePull(await request("/pulls", "POST", { title, body: operation.body,
        head: operation.branch, base: operation.base, draft: true }), title);
      const verified = safePull(await request(`/pulls/${created.number}`), title, created.number);
      const finalPulls = await listCompletePulls();
      if (finalPulls.filter((item) => titleSequence(item.title, code) === nextSequence).length !== 1 ||
        !finalPulls.some((item) => item.number === verified.number && item.title === title) ||
        JSON.stringify(finalPulls.filter((item) => item.number !== verified.number)) !== JSON.stringify(initialPulls) ||
        JSON.stringify(await listCompleteRefs(expected)) !== JSON.stringify(initialRefs)) throw new TransportFailure("REMOTE_CHANGED");
      return { number: verified.number, state: verified.state, draft: true, title,
        url: `https://github.com/${repository.owner}/${repository.repo}/pull/${verified.number}` };
    }
    if (operation.kind === "update-file") {
      const existing = await readContent(operation.path, operation.branch, true);
      if (existing === null ? operation.expectedFileSha !== null :
        z.object({ type: z.literal("file"), path: relativePath, sha }).parse(existing).sha !== operation.expectedFileSha) throw new TransportFailure("REMOTE_CHANGED");
      if (existing !== null && z.object({ path: z.literal(operation.path) }).safeParse(existing).success === false) throw new TransportFailure("PROVIDER_FAILURE");
      await requireHead(operation.branch, operation.expectedHead);
      const result = z.object({ content: z.object({ path: relativePath, sha }), commit: z.object({ sha }) }).parse(await request(
        `/contents/${encodePath(operation.path)}`, "PUT", { branch: operation.branch, message: operation.message,
          content: Buffer.from(operation.content, "utf8").toString("base64"), ...(operation.expectedFileSha === null ? {} : { sha: operation.expectedFileSha }) }));
      const bytes = Buffer.from(operation.content, "utf8");
      const expectedBlob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (result.content.path !== operation.path || result.content.sha !== expectedBlob) throw new TransportFailure("PROVIDER_FAILURE");
      await requireHead(operation.branch, result.commit.sha);
      const verified = z.object({ type: z.literal("file"), path: z.literal(operation.path), sha: z.literal(result.content.sha) }).parse(await readContent(operation.path, operation.branch));
      return { branch: operation.branch, path: operation.path, contentSha: verified.sha, commitSha: result.commit.sha };
    }
    const target = commitSchema.parse(await request(`/git/commits/${operation.targetCommit}`));
    if (target.sha !== operation.targetCommit) throw new TransportFailure("PROVIDER_FAILURE");
    const comparison = z.object({ status: z.enum(["ahead", "identical", "behind", "diverged"]),
      merge_base_commit: z.object({ sha }) }).parse(await request(`/compare/${operation.expectedHead}...${operation.targetCommit}`));
    if (!["ahead", "identical"].includes(comparison.status) || comparison.merge_base_commit.sha !== operation.expectedHead) throw new TransportFailure("REMOTE_CHANGED");
    await requireHead(operation.branch, operation.expectedHead);
    const updated = refSchema.parse(await request(`/git/refs/heads/${encodePath(operation.branch)}`, "PATCH", { sha: operation.targetCommit, force: false }));
    if (updated.ref !== `refs/heads/${operation.branch}` || updated.object.sha !== operation.targetCommit) throw new TransportFailure("PROVIDER_FAILURE");
    await requireHead(operation.branch, operation.targetCommit);
    return { branch: operation.branch, head: operation.targetCommit, previousHead: operation.expectedHead };
  };
  try {
    const result = await Promise.race([perform(), interrupted]);
    await Promise.race([authorize(), interrupted]);
    return { status: "SUCCEEDED", data: result };
  } catch (error) {
    const code = failure?.code ?? (error instanceof TransportFailure ? error.code : "PROVIDER_FAILURE");
    return { status: dispatchedMutation ? "UNKNOWN" : "FAILED", code };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
