import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { executePrivateGithubOperation, PRIVATE_GITHUB_LIMITS, type PrivateGithubInput, type PrivateGithubOperation } from "@/lib/workspace/private-github-api";

const HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const BASE = "c".repeat(40);
const TOKEN = "synthetic_server_token";
const repository = { owner: "fixture", repo: "isolated" };
const ref = (branch = "main", head = HEAD) => ({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: head } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const input = (operation: PrivateGithubOperation, responses: unknown[]) => {
  const fetchMock = vi.fn<typeof fetch>();
  for (const value of responses) fetchMock.mockResolvedValueOnce(value instanceof Response ? value : response(value));
  return { repository, token: TOKEN, operation, revalidate: vi.fn(async () => undefined), fetch: fetchMock } satisfies PrivateGithubInput;
};
const branchOperation = (): PrivateGithubOperation => ({ kind: "create-branch", branch: "feature", fromBranch: "main", expectedHead: HEAD });
const pushOperation = (): PrivateGithubOperation => ({ kind: "advance-branch", branch: "main", expectedHead: HEAD, targetCommit: TARGET });
const pushResponses = () => [ref(), { sha: TARGET, parents: [{ sha: HEAD }] }, { status: "ahead", merge_base_commit: { sha: HEAD } }, ref(), ref("main", TARGET), ref("main", TARGET)];
const pullRepository = { owner: "badadeveloper001-dev", repo: "Cr8or-Studio" };
const pullRepositoryKey = "badadeveloper001-dev/cr8or-studio";
const intendedTitle = "CR8OR-010: General maintenance";
const pull = (title = intendedTitle, number = 7) => ({ number, title, draft: true, state: "open",
  head: { ref: "main", sha: HEAD, repo: { full_name: pullRepositoryKey } },
  base: { ref: "base", sha: BASE, repo: { full_name: pullRepositoryKey } } });
const pullOperation = (): PrivateGithubOperation => ({ kind: "create-pr", branch: "main", base: "base",
  expectedHead: HEAD, expectedBase: BASE, category: "General maintenance", body: "Review changes." });
const pullRefs = () => [{ name: "base", commit: { sha: BASE } }, { name: "main", commit: { sha: HEAD } }];
const pullHistory = (sequence = 9) => [{ sha: HEAD, commit: { message: `CR8OR-${String(sequence).padStart(3, "0")}: Code improvements` } }];
const pullResponses = (sequence = 9): unknown[] => {
  const title = `CR8OR-${String(sequence + 1).padStart(3, "0")}: General maintenance`;
  return [ref(), pullHistory(sequence), pullRefs(), [], [{ sha: BASE, commit: { message: "Initial changes" } }], [],
    pullRefs(), [], [], ref("base", BASE), ref(), pull(title), pull(title), [pull(title)], pullRefs(), []];
};
const pullInput = (responses = pullResponses(), operation = pullOperation()) => ({ ...input(operation, responses), repository: pullRepository });
const dispatchedPulls = (args: ReturnType<typeof pullInput>) => args.fetch.mock.calls.filter(([, init]) => init?.method !== "GET");
afterEach(() => vi.useRealTimers());

describe("bounded private GitHub adapter", () => {
  it("returns only sanitized registered repository metadata", async () => {
    const args = input({ kind: "metadata" }, [{ full_name: "fixture/isolated", private: true, default_branch: "main", clone_url: `https://${TOKEN}@github.com/fixture/isolated`, token: TOKEN }]);
    const result = await executePrivateGithubOperation(args);
    expect(result).toEqual({ status: "SUCCEEDED", data: { ...repository, private: true, defaultBranch: "main", url: "https://github.com/fixture/isolated" } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const [url, init] = args.fetch.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/fixture/isolated");
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(args.revalidate).toHaveBeenCalledTimes(2);
  });
  it("rejects repository response substitution", async () => {
    expect(await executePrivateGithubOperation(input({ kind: "metadata" }, [{ full_name: "unrelated/project", private: true, default_branch: "main" }]))).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
  });
  it.each(["../other", "fixture?x=1", "https://github.com", "-bad", "", "user@evil"])("rejects arbitrary repository input %s", async (owner) => {
    const args = input({ kind: "metadata" }, []);
    args.repository = { owner, repo: "isolated" };
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "INVALID_REQUEST" });
    expect(args.fetch).not.toHaveBeenCalled();
  });
  it.each(["-main", "../main", "main; echo secret", "$(echo x)", "refs//main", "main.lock", "main@{0}", "/main"])("rejects invalid branches %s", async (target) => {
    const args = input({ ...branchOperation(), branch: target } as PrivateGithubOperation, []);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "INVALID_REQUEST" });
    expect(args.fetch).not.toHaveBeenCalled();
  });
  it.each(["/etc/passwd", "../secret", "a/../secret", ".git/config", ".env", ".env.local", ".ssh/id_rsa", "a\\b", "-option", "x".repeat(4097)])("rejects unsafe file paths %s", async (path) => {
    const args = input({ kind: "read-file", branch: "main", path }, []);
    expect((await executePrivateGithubOperation(args)).status).toBe("FAILED");
    expect(args.fetch).not.toHaveBeenCalled();
  });
  it("rejects unexpected untrusted operation fields", async () => {
    const args = input({ kind: "metadata", repo: "unrelated", headers: { Authorization: "forged" } } as PrivateGithubOperation, []);
    expect((await executePrivateGithubOperation(args)).code).toBe("INVALID_REQUEST");
    expect(args.fetch).not.toHaveBeenCalled();
  });
  it.each(["", "\ufeffconst smile = '😀';\r\n", "你好\n世界"])("reads exact bounded UTF-8 content", async (content) => {
    const bytes = Buffer.from(content);
    const args = input({ kind: "read-file", branch: "main", path: "src/source.ts" }, [{ type: "file", path: "src/source.ts", sha: HEAD, encoding: "base64", content: bytes.toString("base64"), size: bytes.length, download_url: "https://secret.invalid" }]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "SUCCEEDED", data: { path: "src/source.ts", sha: HEAD, content } });
  });
  it("rejects incomplete file content and special files", async () => {
    for (const patch of [{ size: 5 }, { encoding: "none" }, { type: "symlink" }, { content: "%%%" }, { path: "other.ts" }]) {
      const args = input({ kind: "read-file", branch: "main", path: "source.ts" }, [{ type: "file", path: "source.ts", sha: HEAD, encoding: "base64", content: "eA==", size: 1, ...patch }]);
      expect((await executePrivateGithubOperation(args)).status).toBe("FAILED");
    }
  });
  it("bounds listings and declares possible pagination instead of presenting a complete result", async () => {
    const branches = Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index}`, commit: { sha: HEAD }, secret: TOKEN }));
    const result = await executePrivateGithubOperation(input({ kind: "branches" }, [branches]));
    expect(result).toMatchObject({ status: "SUCCEEDED", data: { possiblyIncomplete: true } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect((await executePrivateGithubOperation(input({ kind: "branches" }, [[...branches, branches[0]]]))).status).toBe("FAILED");
  });
  it("reads scoped contents and recent commit IDs without provider metadata", async () => {
    expect(await executePrivateGithubOperation(input({ kind: "contents", branch: "main", path: "src" }, [[{ type: "file", name: "one.ts", path: "src/one.ts", sha: HEAD, download_url: "secret" }]])))
      .toEqual({ status: "SUCCEEDED", data: { items: [{ type: "file", name: "one.ts", path: "src/one.ts", sha: HEAD }], possiblyIncomplete: false } });
    expect(await executePrivateGithubOperation(input({ kind: "commits", branch: "main" }, [[{ sha: HEAD, commit: { message: TOKEN } }]])))
      .toEqual({ status: "SUCCEEDED", data: { commits: [{ sha: HEAD, sequence: null }], complete: true } });
  });
  it("returns bounded neutral commit sequence metadata without arbitrary commit messages", async () => {
    const result = await executePrivateGithubOperation(input({ kind: "commits", branch: "main" }, [[
      { sha: HEAD, commit: { message: "PROJECT-009: General maintenance\nprivate detail" } },
      { sha: BASE, commit: { message: TOKEN } },
    ]]));
    expect(result).toEqual({ status: "SUCCEEDED", data: { commits: [{ sha: HEAD, sequence: 9 }, { sha: BASE, sequence: null }], complete: true } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("private detail");
  });
  it.each(["PROJECT-001: Credential replacement", "OTHER-001: General maintenance", "PROJECT-001: General maintenance\nSecret", "PROJECT-1000000000: General maintenance"])("rejects commit titles outside the neutral catalogue %s", async (message) => {
    const args = input({ kind: "update-file", branch: "main", expectedHead: HEAD, path: "source.ts", expectedFileSha: null, content: "", message }, []);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "INVALID_REQUEST" });
    expect(args.fetch).not.toHaveBeenCalled();
  });
  it("derives the next sequence from complete branch and tag histories, including another branch's higher identifier", async () => {
    const branches = [{ name: "main", commit: { sha: HEAD } }, { name: "feature", commit: { sha: TARGET } }];
    const tags = [{ name: "v1", commit: { sha: BASE } }];
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD }, [branches, tags,
      [{ sha: TARGET, commit: { message: "PROJECT-040: General maintenance" } }],
      [{ sha: HEAD, commit: { message: "PROJECT-002: General maintenance" } }],
      [{ sha: BASE, commit: { message: "PROJECT-050: General maintenance" } }], branches, tags]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "SUCCEEDED", data: { head: HEAD, nextSequence: 51 } });
    expect(args.fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(args.fetch).toHaveBeenCalledTimes(7);
  });
  it("deduplicates identical branch/tag tips and returns no raw history text", async () => {
    const branches = [{ name: "main", commit: { sha: HEAD } }, { name: "feature", commit: { sha: HEAD } }];
    const tags = [{ name: "v1", commit: { sha: HEAD } }];
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD }, [branches, tags,
      [{ sha: HEAD, commit: { message: `PROJECT-009: General maintenance\n${TOKEN}` } }], branches, tags]);
    const result = await executePrivateGithubOperation(args);
    expect(result).toEqual({ status: "SUCCEEDED", data: { head: HEAD, nextSequence: 10 } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(args.fetch).toHaveBeenCalledTimes(5);
  });
  it.each(["branches", "tags", "history"])("rejects an incomplete %s page for commit numbering", async (part) => {
    const branches = [{ name: "main", commit: { sha: HEAD } }];
    const fullRefs = Array.from({ length: 100 }, (_, index) => ({ name: `ref-${index}`, commit: { sha: HEAD } }));
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD },
      part === "branches" ? [fullRefs, []] : part === "tags" ? [branches, fullRefs] :
        [branches, [], Array.from({ length: 100 }, () => ({ sha: HEAD, commit: { message: "General changes" } }))]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
  });
  it("rejects excessive ref counts before scanning histories", async () => {
    const branches = [{ name: "main", commit: { sha: HEAD } }, ...Array.from({ length: 32 }, (_, index) => ({ name: `ref-${index}`, commit: { sha: HEAD } }))];
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD }, [branches, []]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
    expect(args.fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects changed branch or tag scope before releasing the sequence", async () => {
    const branches = [{ name: "main", commit: { sha: HEAD } }];
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD }, [branches, [],
      [{ sha: HEAD, commit: { message: "PROJECT-009: General maintenance" } }], branches, [{ name: "new-tag", commit: { sha: TARGET } }]]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
  });
  it("rejects a pagination link even when the first page contains fewer than 100 entries", async () => {
    const paginated = response([{ name: "main", commit: { sha: HEAD } }]);
    paginated.headers.set("Link", '<https://api.github.com/repos/fixture/isolated/branches?page=2>; rel="next"');
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD }, [paginated]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
    expect(args.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects numbering when the registered branch no longer has the expected head", async () => {
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD }, [[{ name: "main", commit: { sha: TARGET } }], []]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
    expect(args.fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects sequence exhaustion without releasing a reused identifier", async () => {
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD }, [[{ name: "main", commit: { sha: HEAD } }], [],
      [{ sha: HEAD, commit: { message: "PROJECT-999999999: General maintenance" } }]]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
  });
  it("bounds unique commits across all reference histories", async () => {
    const oid = (value: number) => value.toString(16).padStart(40, "0");
    const refs = Array.from({ length: 11 }, (_, index) => ({ name: index ? `ref-${index}` : "main", commit: { sha: index ? oid(index) : HEAD } }));
    const history = [...refs].sort((left, right) => left.name.localeCompare(right.name)).map((item, index) => [
      { sha: item.commit.sha, commit: { message: "General changes" } },
      ...Array.from({ length: 98 }, (_, itemIndex) => ({ sha: oid(1000 + index * 100 + itemIndex), commit: { message: "General changes" } })),
    ]);
    const args = input({ kind: "commit-sequence", branch: "main", expectedHead: HEAD }, [refs, [], ...history]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
    expect(args.fetch).toHaveBeenCalledTimes(13);
  });
  it("creates an exact pinned branch and verifies the remote result", async () => {
    const args = input(branchOperation(), [ref(), ref("feature"), ref("feature")]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "SUCCEEDED", data: { branch: "feature", head: HEAD } });
    expect(args.fetch.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ ref: "refs/heads/feature", sha: HEAD }) });
    expect(args.revalidate).toHaveBeenCalledTimes(4);
  });
  it("rejects unexpected remote change before mutation", async () => {
    const args = input(branchOperation(), [ref("main", TARGET)]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
    expect(args.fetch).toHaveBeenCalledTimes(1);
  });
  it("marks ambiguous mutation outcomes UNKNOWN without retrying or leaking provider errors", async () => {
    const args = input(branchOperation(), [ref()]);
    args.fetch.mockRejectedValueOnce(new Error(`Authorization: ${TOKEN}`));
    const result = await executePrivateGithubOperation(args);
    expect(result).toEqual({ status: "UNKNOWN", code: "PROVIDER_FAILURE" });
    expect(args.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
  it("does not retry provider refusals or report a mutation successful without verification", async () => {
    for (const status of [401, 403, 409, 422, 500]) {
      const args = input(branchOperation(), [ref(), response({ message: TOKEN }, status)]);
      expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "PROVIDER_FAILURE" });
      expect(args.fetch).toHaveBeenCalledTimes(2);
    }
  });
  it("uses only a verified existing commit and force:false for a fast-forward reference update", async () => {
    const args = input(pushOperation(), pushResponses());
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "SUCCEEDED", data: { branch: "main", previousHead: HEAD, head: TARGET } });
    expect(args.fetch.mock.calls[4][1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ sha: TARGET, force: false }) });
    expect(args.fetch.mock.calls.every(([url]) => String(url).startsWith("https://api.github.com/repos/fixture/isolated/"))).toBe(true);
  });
  it.each(["behind", "diverged"])("rejects non-fast-forward push %s", async (status) => {
    const args = input(pushOperation(), [ref(), { sha: TARGET, parents: [] }, { status, merge_base_commit: { sha: HEAD } }]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
    expect(args.fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("rejects a second remote change immediately before push dispatch", async () => {
    const responses = pushResponses(); responses[3] = ref("main", BASE);
    const args = input(pushOperation(), responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
    expect(args.fetch).toHaveBeenCalledTimes(4);
  });
  it("reports uncertain push outcome when the verified remote head differs", async () => {
    const responses = pushResponses(); responses[5] = ref("main", BASE);
    const args = input(pushOperation(), responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "REMOTE_CHANGED" });
    expect(args.fetch).toHaveBeenCalledTimes(6);
  });
  it("creates and confirms the deterministic sequential draft PR title from the approved head", async () => {
    const args = pullInput();
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "SUCCEEDED", data: {
      number: 7, state: "open", draft: true, title: intendedTitle,
      url: "https://github.com/badadeveloper001-dev/Cr8or-Studio/pull/7",
    } });
    expect(dispatchedPulls(args)).toHaveLength(1);
    expect(JSON.parse(dispatchedPulls(args)[0][1]?.body as string)).toEqual({
      title: intendedTitle, body: "Review changes.", head: "main", base: "base", draft: true,
    });
    expect(args.fetch.mock.calls.every(([url]) => String(url).startsWith("https://api.github.com/repos/badadeveloper001-dev/Cr8or-Studio/"))).toBe(true);
  });
  it.each([0, 1, 11, 999, 999_999_998])("numbers from complete immutable project history after sequence %i", async (sequence) => {
    const args = pullInput(pullResponses(sequence));
    const title = `CR8OR-${String(sequence + 1).padStart(3, "0")}: General maintenance`;
    expect(await executePrivateGithubOperation(args)).toMatchObject({ status: "SUCCEEDED", data: { title } });
    expect(JSON.parse(dispatchedPulls(args)[0][1]?.body as string).title).toBe(title);
  });
  it("ignores unrelated project namespaces in the authorized repository's immutable history", async () => {
    const responses = pullResponses();
    responses[1] = [...pullHistory(), { sha: TARGET, commit: { message: "UNRELATED-999: General maintenance" } }];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toMatchObject({ status: "SUCCEEDED", data: { title: intendedTitle } });
  });
  it.each(["fixture/isolated", "attacker/Cr8or-Studio", "badadeveloper001-dev/other"])('rejects unknown trusted project mapping %s before fetching', async (key) => {
    const [owner, repo] = key.split("/");
    const args = { ...pullInput(), repository: { owner, repo } };
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "INVALID_REQUEST" });
    expect(args.fetch).not.toHaveBeenCalled();
  });
  it.each(["CR8OR-999: General maintenance", "General maintenance", "Secret title"])('rejects caller-supplied title %s', async (title) => {
    const args = pullInput([], { ...pullOperation(), title } as unknown as PrivateGithubOperation);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "INVALID_REQUEST" });
    expect(args.fetch).not.toHaveBeenCalled();
  });
  it.each(["Credential repair", "General maintenance\nSecret", "Code improvements; execute"])('rejects categories outside the trusted catalogue %s', async (category) => {
    const args = pullInput([], { ...pullOperation(), category } as PrivateGithubOperation);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "INVALID_REQUEST" });
    expect(args.fetch).not.toHaveBeenCalled();
  });
  it.each(["General maintenance", "Code improvements", "Documentation updates", "Test improvements", "Configuration updates"] as const)("preserves permitted category %s", async (category) => {
    const title = `CR8OR-010: ${category}`;
    const responses = pullResponses();
    responses[11] = pull(title); responses[12] = pull(title); responses[13] = [pull(title)];
    const args = pullInput(responses, { ...pullOperation(), category } as PrivateGithubOperation);
    expect(await executePrivateGithubOperation(args)).toMatchObject({ status: "SUCCEEDED", data: { title } });
  });
  it.each([9, 12])("rejects an already consumed or stale candidate when PR history has sequence %i", async (sequence) => {
    const responses = pullResponses();
    responses[5] = [pull(`CR8OR-${String(sequence + 1).padStart(3, "0")}: General maintenance`, 6)];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
    expect(dispatchedPulls(args)).toHaveLength(0);
  });
  it("rejects stale numbering used by another branch or tag commit", async () => {
    const responses = pullResponses();
    responses[4] = [{ sha: BASE, commit: { message: "CR8OR-010: Code improvements" } }];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
    expect(dispatchedPulls(args)).toHaveLength(0);
  });
  it("takes the maximum identifier across the complete approved ancestry, not only the tip commit", async () => {
    const responses = pullResponses();
    responses[1] = [{ sha: HEAD, commit: { message: "Unnumbered change" } },
      { sha: TARGET, commit: { message: "CR8OR-009: Code improvements" } }];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toMatchObject({ status: "SUCCEEDED", data: { title: intendedTitle } });
  });
  it("rejects reuse of a closed PR's identifier", async () => {
    const responses = pullResponses(); responses[5] = [{ ...pull(), state: "closed" }];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
    expect(dispatchedPulls(args)).toHaveLength(0);
    expect(args.fetch.mock.calls[5][0]).toContain("/pulls?state=all&per_page=100");
  });
  it("rejects exhausted project numbering before creating a PR", async () => {
    const responses = pullResponses(); responses[1] = pullHistory(999_999_999);
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
    expect(dispatchedPulls(args)).toHaveLength(0);
  });
  it("requires a complete, unique-numbered PR listing", async () => {
    for (const items of [Array.from({ length: 100 }, (_, index) => pull("Unrelated previous work", index + 1)),
      [pull("Earlier work", 6), pull("Other work", 6)]]) {
      const responses = pullResponses(); responses[5] = items;
      const args = pullInput(responses);
      expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
      expect(dispatchedPulls(args)).toHaveLength(0);
    }
  });
  it("does not number from incomplete or substituted immutable history", async () => {
    for (const history of [[], [{ sha: TARGET, commit: { message: "CR8OR-009: General maintenance" } }],
      Array.from({ length: 100 }, () => pullHistory()[0])]) {
      const responses = pullResponses(); responses[1] = history;
      const args = pullInput(responses);
      expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
      expect(dispatchedPulls(args)).toHaveLength(0);
    }
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("rejects paginated numbering evidence at request %i", async (index) => {
    const responses = pullResponses();
    const page = response(responses[index]); page.headers.set("Link", '<https://untrusted.invalid/next>; rel="next"');
    responses[index] = page;
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
    expect(dispatchedPulls(args)).toHaveLength(0);
    expect(args.fetch.mock.calls.some(([url]) => String(url).includes("untrusted.invalid"))).toBe(false);
  });
  it("rejects a PR-list response from another repository before sequence selection", async () => {
    const wrong = pull(); wrong.base.repo.full_name = "another/project";
    const responses = pullResponses(); responses[5] = [wrong];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
    expect(dispatchedPulls(args)).toHaveLength(0);
  });
  it("rejects PR or branch snapshot changes immediately before creation", async () => {
    for (const index of [6, 8, 9, 10]) {
      const responses = pullResponses();
      responses[index] = index === 6 ? [{ name: "main", commit: { sha: TARGET } }] :
        index === 8 ? [pull()] : index === 9 ? ref("base", TARGET) : ref("main", TARGET);
      const args = pullInput(responses);
      expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "REMOTE_CHANGED" });
      expect(dispatchedPulls(args)).toHaveLength(0);
    }
  });
  const pullMutations = [
    ["non-draft", (value: ReturnType<typeof pull>) => { value.draft = false; }],
    ["missing draft", (value: ReturnType<typeof pull>) => { delete (value as Partial<typeof value>).draft; }],
    ["title", (value: ReturnType<typeof pull>) => { value.title = "CR8OR-011: General maintenance"; }],
    ["state", (value: ReturnType<typeof pull>) => { value.state = "closed"; }],
    ["head repository", (value: ReturnType<typeof pull>) => { value.head.repo.full_name = "another/project"; }],
    ["base repository", (value: ReturnType<typeof pull>) => { value.base.repo.full_name = "another/project"; }],
    ["head branch", (value: ReturnType<typeof pull>) => { value.head.ref = "other"; }],
    ["base branch", (value: ReturnType<typeof pull>) => { value.base.ref = "other"; }],
    ["head SHA", (value: ReturnType<typeof pull>) => { value.head.sha = TARGET; }],
    ["base SHA", (value: ReturnType<typeof pull>) => { value.base.sha = TARGET; }],
  ] as const;
  describe.each([11, 12])("validates both creation and fetched PR responses at request %i", (index) => {
    it.each(pullMutations)("reports %s mismatch as UNKNOWN and never retries or repairs the PR", async (_label, mutate) => {
      const wrong = pull(); mutate(wrong);
      const responses = pullResponses(); responses[index] = wrong;
      const args = pullInput(responses);
      expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "PROVIDER_FAILURE" });
      expect(dispatchedPulls(args)).toHaveLength(1);
      expect(dispatchedPulls(args)[0][1]?.method).toBe("POST");
      expect(args.fetch).toHaveBeenCalledTimes(index + 1);
    });
  });
  it("rejects fetched PR number substitution", async () => {
    const responses = pullResponses(); responses[12] = pull(intendedTitle, 8);
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "PROVIDER_FAILURE" });
    expect(dispatchedPulls(args)).toHaveLength(1);
  });
  it("keeps a duplicate identifier appearing during creation UNKNOWN without modifying either PR", async () => {
    const responses = pullResponses(); responses[13] = [pull(), pull("CR8OR-010: Code improvements", 8)];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "REMOTE_CHANGED" });
    expect(dispatchedPulls(args)).toHaveLength(1);
  });
  it("requires the complete post-creation snapshot to contain exactly the old PRs and new PR", async () => {
    for (const final of [[], [pull(), pull("CR8OR-011: General maintenance", 8)]]) {
      const responses = pullResponses(); responses[13] = final;
      const args = pullInput(responses);
      expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "REMOTE_CHANGED" });
      expect(dispatchedPulls(args)).toHaveLength(1);
    }
  });
  it("preserves existing identifiers and allows a prior lower-numbered PR", async () => {
    const responses = pullResponses(); const previous = pull("CR8OR-008: Test improvements", 6);
    responses[5] = [previous]; responses[8] = [previous]; responses[13] = [previous, pull()];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toMatchObject({ status: "SUCCEEDED", data: { title: intendedTitle } });
    expect(dispatchedPulls(args)).toHaveLength(1);
  });
  it("keeps post-creation branch changes UNKNOWN", async () => {
    const responses = pullResponses(); responses[14] = [{ name: "main", commit: { sha: TARGET } }];
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "REMOTE_CHANGED" });
    expect(dispatchedPulls(args)).toHaveLength(1);
  });
  it("sanitizes failed fetched confirmation and never recreates a potentially created PR", async () => {
    const responses = pullResponses(); responses[12] = response({ message: TOKEN }, 500);
    const args = pullInput(responses);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "PROVIDER_FAILURE" });
    expect(dispatchedPulls(args)).toHaveLength(1);
  });
  it.each(["", "const unicode = '𝒜😀';\r\n"])("writes exact UTF-8 through the JSON body with expected blob and branch checks", async (content) => {
    const bytes = Buffer.from(content);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const args = input({ kind: "update-file", branch: "main", expectedHead: HEAD, path: "source.ts", expectedFileSha: BASE, content, message: "PROJECT-001: General maintenance" }, [ref(), { type: "file", path: "source.ts", sha: BASE }, ref(), { content: { path: "source.ts", sha: blob }, commit: { sha: TARGET } }, ref("main", TARGET), { type: "file", path: "source.ts", sha: blob }]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "SUCCEEDED", data: { branch: "main", path: "source.ts", contentSha: blob, commitSha: TARGET } });
    const dispatched = JSON.parse(args.fetch.mock.calls[3][1]?.body as string);
    expect(dispatched).toEqual({ branch: "main", message: "PROJECT-001: General maintenance", content: bytes.toString("base64"), sha: BASE });
    expect(args.fetch.mock.calls.some(([url]) => String(url).includes(TOKEN))).toBe(false);
  });
  it("rejects oversized and malformed write data before network requests", async () => {
    for (const content of ["x".repeat(PRIVATE_GITHUB_LIMITS.fileBytes + 1), "\ud800"]) {
      const args = input({ kind: "update-file", branch: "main", expectedHead: HEAD, path: "source.ts", expectedFileSha: null, content, message: "PROJECT-001: General maintenance" }, []);
      expect((await executePrivateGithubOperation(args)).code).toBe("INVALID_REQUEST");
      expect(args.fetch).not.toHaveBeenCalled();
    }
  });
  it("rejects file content mismatch after dispatch as an uncertain outcome", async () => {
    const args = input({ kind: "update-file", branch: "main", expectedHead: HEAD, path: "source.ts", expectedFileSha: null, content: "changed", message: "PROJECT-001: General maintenance" }, [ref(), response({}, 404), ref(), { content: { path: "source.ts", sha: BASE }, commit: { sha: TARGET } }]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "PROVIDER_FAILURE" });
  });
  it("does not dispatch after revocation or disclose a read result after authorization fails", async () => {
    const args = input(branchOperation(), [ref()]);
    args.revalidate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(TOKEN));
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "AUTHORIZATION_INVALID" });
    expect(args.fetch).toHaveBeenCalledTimes(1);
    const reading = input({ kind: "branches" }, [[]]);
    reading.revalidate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(TOKEN));
    expect(await executePrivateGithubOperation(reading)).toEqual({ status: "FAILED", code: "AUTHORIZATION_INVALID" });
  });
  it("retains uncertainty if authorization is revoked after mutation dispatch", async () => {
    const args = input(branchOperation(), [ref(), ref("feature")]);
    args.revalidate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "UNKNOWN", code: "AUTHORIZATION_INVALID" });
    expect(args.fetch).toHaveBeenCalledTimes(2);
  });
  it("aborts on an interrupted request without claiming remote cancellation", async () => {
    const controller = new AbortController();
    const args = input(branchOperation(), [ref()]);
    args.fetch.mockImplementationOnce(async () => { controller.abort(); throw new Error(TOKEN); });
    expect(await executePrivateGithubOperation({ ...args, signal: controller.signal })).toEqual({ status: "UNKNOWN", code: "CANCELLED" });
    expect(args.fetch).toHaveBeenCalledTimes(2);
  });
  it("bounds an unresponsive provider and stops subsequent requests", async () => {
    vi.useFakeTimers();
    const args = input(branchOperation(), [ref()]);
    args.fetch.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = executePrivateGithubOperation(args);
    await vi.advanceTimersByTimeAsync(PRIVATE_GITHUB_LIMITS.durationMs + 1);
    expect(await pending).toEqual({ status: "UNKNOWN", code: "TIMEOUT" });
    expect(args.fetch).toHaveBeenCalledTimes(2);
    expect((args.fetch.mock.calls[1][1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it("rejects oversized provider output without returning a truncated success", async () => {
    const args = input({ kind: "metadata" }, [new Response("x".repeat(PRIVATE_GITHUB_LIMITS.responseBytes + 1), { headers: { "content-type": "application/json" } })]);
    expect(await executePrivateGithubOperation(args)).toEqual({ status: "FAILED", code: "PROVIDER_FAILURE" });
  });
  it("reads pull check summaries only for the registered repository and branch", async () => {
    const checks = { total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success", html_url: `https://${TOKEN}@evil.invalid` }] };
    const result = await executePrivateGithubOperation(pullInput([pull(), checks], { kind: "pr-checks", branch: "main", pullNumber: 7 }));
    expect(result).toEqual({ status: "SUCCEEDED", data: { pullNumber: 7, state: "open", head: HEAD, checkRuns: [{ name: "build", status: "completed", conclusion: "success" }], possiblyIncomplete: false } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
