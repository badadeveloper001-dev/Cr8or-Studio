import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({ validate: vi.fn(), reserve: vi.fn(), mark: vi.fn(), finish: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/security/git-authorization", () => ({ validateGitAuthorization: persistence.validate }));
vi.mock("@/lib/security/git-operation-store", () => ({
  reserveGitOperation: persistence.reserve, markGitDispatched: persistence.mark, finishGitOperation: persistence.finish,
}));
vi.mock("@/lib/security/audit", () => ({ appendAuditEvent: persistence.audit }));

import type { ExecutionAuthorizationContext, ExecutionWorkspace } from "@/lib/security/execution-context";
import type { GitAuthorization } from "@/lib/security/git-authorization";
import { buildGitOperationScope, gitScopeDigest, parseGitOperation } from "@/lib/security/git-operation-catalogue";
import { GIT_PULL_CATEGORIES } from "@/lib/security/git-project-naming";
import { createGithubGitAdapter, executeAuthorizedGitOperation } from "@/lib/workspace/private-git-operations";

// Only HTTP and coordination persistence are substituted. These tests execute
// the production adapter factory and production GitHub transport together.
// Synthetic responses are not evidence of live GitHub/provider compatibility.
const repositoryKey = "badadeveloper001-dev/cr8or-studio";
const base = "b".repeat(40);
const other = "c".repeat(40);
const token = "synthetic_adapter_test_token";
const operationId = "bca2e39f-b864-4f55-80f4-c706ef391e12";
const grant = Object.freeze({}) as GitAuthorization;
type Pull = {
  number: number; title: string; draft: boolean; state: string;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
};
type FixtureOptions = {
  sequence?: number;
  category?: typeof GIT_PULL_CATEGORIES[number];
  existingTitle?: string;
  otherBranchSequence?: number;
  initialPatch?: (pull: Pull) => unknown;
  fetchedPatch?: (pull: Pull) => unknown;
  fetchAfterCreateFails?: boolean;
  conflictingPostflight?: boolean;
  priorPullRepository?: string;
};

function fixture(options: FixtureOptions = {}) {
  const sequence = options.sequence ?? 11;
  const head = sequence.toString(16).padStart(40, "0");
  const category = options.category ?? "General maintenance";
  const title = `CR8OR-${String(sequence).padStart(3, "0")}: ${category}`;
  const workspace: ExecutionWorkspace = { id: "registered-workspace", runtimeType: "cloud", provider: "daytona",
    providerWorkspaceId: "registered-sandbox", repositoryUrl: `https://github.com/${repositoryKey}.git`, branch: "feature/review" };
  const context = { projectId: "registered-project", workspace, signal: new AbortController().signal, executionId: "execution-fixture" } as unknown as ExecutionAuthorizationContext;
  const request = parseGitOperation({ operation: "create-pr", branch: workspace.branch,
    expectedRemoteHead: head, baseBranch: "main", expectedBase: base, category });
  const scope = buildGitOperationScope(context, request);
  const pull = (): Pull => ({ number: 42, title, draft: true, state: "open",
    head: { ref: "feature/review", sha: head, repo: { full_name: repositoryKey } },
    base: { ref: "main", sha: base, repo: { full_name: repositoryKey } } });
  const refs = [
    { name: "feature/review", commit: { sha: head } }, { name: "main", commit: { sha: base } },
    ...(options.otherBranchSequence === undefined ? [] : [{ name: "other-work", commit: { sha: other } }]),
  ];
  const prior = { number: 7, title: options.existingTitle ?? "CR8OR-010: General maintenance", state: "closed", draft: false,
    base: { repo: { full_name: options.priorPullRepository ?? repositoryKey } } };
  let posted = false;
  const mutations: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const unexpected: string[] = [];
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const prefix = `/repos/${repositoryKey}`;
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`${prefix}/`)) {
      unexpected.push(String(input));
      throw new Error("Unexpected synthetic repository target.");
    }
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      mutations.push({ method, path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (method !== "POST" || path !== "/pulls" || posted) {
        unexpected.push(`${method} ${path}`);
        throw new Error("Unexpected synthetic mutation.");
      }
      posted = true;
      return json(options.initialPatch ? options.initialPatch(pull()) : pull());
    }
    if (path === "/git/ref/heads/feature/review") return json({ ref: "refs/heads/feature/review", object: { type: "commit", sha: head } });
    if (path === "/git/ref/heads/main") return json({ ref: "refs/heads/main", object: { type: "commit", sha: base } });
    if (path === "/branches") return json(refs);
    if (path === "/tags") return json([]);
    if (path === "/commits") {
      const tip = url.searchParams.get("sha");
      if (tip === head) return json([{ sha: head, commit: { message: `CR8OR-${String(sequence).padStart(3, "0")}: ${category}` } }]);
      if (tip === base) return json([{ sha: base, commit: { message: "CR8OR-001: General maintenance" } }]);
      if (tip === other) return json([{ sha: other, commit: { message: `CR8OR-${String(options.otherBranchSequence).padStart(3, "0")}: Code improvements` } }]);
    }
    if (path === "/pulls") {
      if (url.searchParams.get("state") !== "all") unexpected.push("Pull history was not complete.");
      return json([prior, ...(posted ? [pull()] : []),
        ...(posted && options.conflictingPostflight ? [{ ...pull(), number: 43 }] : [])]);
    }
    if (path === "/pulls/42") {
      if (options.fetchAfterCreateFails) throw new Error("Synthetic transport disconnected after creation.");
      return json(options.fetchedPatch ? options.fetchedPatch(pull()) : pull());
    }
    unexpected.push(`${method} ${path}`);
    throw new Error("Unexpected synthetic request.");
  });
  const revalidate = vi.fn(async () => undefined);
  const adapter = createGithubGitAdapter(() => token, fetcher);
  const execute = () => adapter.execute(request, scope, revalidate, context.signal);
  return { adapter, execute, request, scope, context, fetcher, revalidate, title, head, mutations, unexpected };
}

beforeEach(() => {
  vi.resetAllMocks();
  persistence.reserve.mockResolvedValue(undefined);
  persistence.mark.mockResolvedValue(undefined);
  persistence.finish.mockResolvedValue(undefined);
});

describe("trusted create-PR adapter through the GitHub HTTP transport", () => {
  it.each(GIT_PULL_CATEGORIES)("creates and verifies the intended numbered draft for %s", async category => {
    const test = fixture({ category });
    expect(await test.execute()).toEqual({ status: "SUCCEEDED", cancellationConfirmed: true, cleanupConfirmed: true,
      data: { number: 42, state: "open", draft: true, title: test.title,
        url: `https://github.com/${repositoryKey}/pull/42` } });
    expect(test.mutations).toEqual([{ method: "POST", path: "/pulls", body: {
      title: `CR8OR-011: ${category}`, body: "Created through an authorized Cr8or Studio operation.",
      head: "feature/review", base: "main", draft: true,
    } }]);
    expect(test.unexpected).toEqual([]);
    expect(test.revalidate.mock.calls.length).toBeGreaterThan(test.fetcher.mock.calls.length);
    for (const [url, init] of test.fetcher.mock.calls) {
      expect(String(url)).toMatch(new RegExp(`^https://api\\.github\\.com/repos/${repositoryKey}/`));
      expect(String(url)).not.toContain(token);
      expect(init).toMatchObject({ redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
      expect(String(init?.body)).not.toContain(token);
    }
  });

  it("advances numbering only when a newly approved immutable head advances history", async () => {
    const first = fixture({ sequence: 11 });
    const second = fixture({ sequence: 12, existingTitle: "CR8OR-011: General maintenance" });
    expect((await first.execute()).status).toBe("SUCCEEDED");
    expect((await second.execute()).status).toBe("SUCCEEDED");
    expect(first.scope.expectedRemoteHead).not.toBe(second.scope.expectedRemoteHead);
    expect(first.mutations[0].body.title).toBe("CR8OR-011: General maintenance");
    expect(second.mutations[0].body.title).toBe("CR8OR-012: General maintenance");
  });

  it.each(["title", "sequence", "projectCode"])("rejects caller-supplied %s before adapter dispatch", field => {
    const test = fixture();
    expect(() => parseGitOperation({ ...test.request, [field]: "ATTACKER-999: Replace approved operation" })).toThrow();
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it("rejects an unregistered project naming identity without deriving a code from a request", () => {
    const test = fixture();
    expect(() => buildGitOperationScope({ ...test.context,
      workspace: { ...test.context.workspace, repositoryUrl: "https://github.com/unrelated/cr8or-studio" } }, test.request)).toThrow();
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it("does not let an unrelated repository influence authorized numbering", async () => {
    const test = fixture({ priorPullRepository: "unrelated/cr8or-studio", existingTitle: "CR8OR-999: General maintenance" });
    expect((await test.execute()).status).toBe("FAILED");
    expect(test.mutations).toEqual([]);
    expect(test.unexpected).toEqual([]);
  });

  it("freezes the naming rule and approved operation data and digests a changed category differently", () => {
    const test = fixture();
    const digest = gitScopeDigest(test.scope);
    expect(() => { (test.scope.pullRequestNaming as { projectCode: string }).projectCode = "FORGED"; }).toThrow(TypeError);
    expect(() => { (test.request as { category: string }).category = "Code improvements"; }).toThrow(TypeError);
    expect(gitScopeDigest(test.scope)).toBe(digest);
    const changed = parseGitOperation({ ...test.request, category: "Code improvements" });
    expect(gitScopeDigest(buildGitOperationScope(test.context, changed))).not.toBe(digest);
  });

  it.each([
    { category: "Test improvements" }, { expectedRemoteHead: other }, { expectedBase: other }, { baseBranch: "other-base" },
  ])("rejects operation substitution against the approved scope before token access: %j", async replacement => {
    const test = fixture();
    const credential = vi.fn(() => token);
    const adapter = createGithubGitAdapter(credential, test.fetcher);
    const changed = parseGitOperation({ ...test.request, ...replacement });
    await expect(adapter.execute(changed, test.scope, test.revalidate, test.context.signal)).rejects.toMatchObject({ status: 403 });
    expect(credential).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.mutations).toEqual([]);
  });

  it.each([
    { existingTitle: "CR8OR-012: Test improvements" },
    { existingTitle: "CR8OR-020: General maintenance" },
    { otherBranchSequence: 12 },
  ])("rejects occupied or stale numbering without choosing a new title: %j", async options => {
    const test = fixture(options);
    expect(await test.execute()).toMatchObject({ status: "FAILED" });
    expect(test.mutations).toEqual([]);
    expect(test.unexpected).toEqual([]);
  });

  const mismatches: [string, (pull: Pull) => unknown][] = [
    ["non-draft", pull => ({ ...pull, draft: false })],
    ["missing draft status", pull => { const result: Partial<Pull> = { ...pull }; delete result.draft; return result; }],
    ["title", pull => ({ ...pull, title: "CR8OR-999: General maintenance" })],
    ["head branch", pull => ({ ...pull, head: { ...pull.head, ref: "other-head" } })],
    ["base branch", pull => ({ ...pull, base: { ...pull.base, ref: "other-base" } })],
    ["head SHA", pull => ({ ...pull, head: { ...pull.head, sha: other } })],
    ["base SHA", pull => ({ ...pull, base: { ...pull.base, sha: other } })],
    ["head repository", pull => ({ ...pull, head: { ...pull.head, repo: { full_name: "unrelated/repository" } } })],
    ["base repository", pull => ({ ...pull, base: { ...pull.base, repo: { full_name: "unrelated/repository" } } })],
    ["closed status", pull => ({ ...pull, state: "closed" })],
    ["invalid number", pull => ({ ...pull, number: 0 })],
  ];
  describe.each(["creation", "fetch"] as const)("verification of %s response", phase => {
    it.each(mismatches)("keeps a %s mismatch UNKNOWN without another mutation", async (_label, patch) => {
      const test = fixture(phase === "creation" ? { initialPatch: patch } : { fetchedPatch: patch });
      expect(await test.execute()).toEqual({ status: "UNKNOWN", data: undefined, cancellationConfirmed: false, cleanupConfirmed: false });
      expect(test.mutations).toHaveLength(1);
      expect(test.mutations[0]).toMatchObject({ method: "POST", path: "/pulls" });
      expect(test.unexpected).toEqual([]);
    });
  });

  it("rejects a fetched PR number substituted after creation", async () => {
    const test = fixture({ fetchedPatch: pull => ({ ...pull, number: 99 }) });
    expect((await test.execute()).status).toBe("UNKNOWN");
    expect(test.mutations).toHaveLength(1);
    expect(test.unexpected).toEqual([]);
  });

  it("retains UNKNOWN when the postflight snapshot discovers a duplicate identifier", async () => {
    const test = fixture({ conflictingPostflight: true });
    expect((await test.execute()).status).toBe("UNKNOWN");
    expect(test.mutations).toHaveLength(1);
    expect(test.unexpected).toEqual([]);
  });

  it.each([
    { fetchAfterCreateFails: true },
    { fetchedPatch: (pull: Pull) => ({ ...pull, draft: false }) },
  ])("persists ambiguous adapter outcomes as UNKNOWN and suppresses receipt data: %#", async options => {
    const test = fixture(options);
    persistence.validate.mockResolvedValue({ operationId, executionId: "execution-fixture", actorId: "owner", scope: test.scope });
    const result = await executeAuthorizedGitOperation(grant, test.context, test.request, test.adapter);
    expect(result).toEqual({ operationId, status: "UNKNOWN", cancellationConfirmed: false, cleanupConfirmed: false });
    expect(persistence.finish).toHaveBeenCalledExactlyOnceWith(operationId, {
      status: "UNKNOWN", exitCode: undefined, cancellationConfirmed: false, cleanupConfirmed: false,
    });
    expect(persistence.reserve).toHaveBeenCalledOnce();
    expect(persistence.mark).toHaveBeenCalledOnce();
    expect(test.mutations).toHaveLength(1);
    expect(test.unexpected).toEqual([]);
    expect(JSON.stringify(persistence.audit.mock.calls)).not.toContain(token);
    expect(JSON.stringify(persistence.audit.mock.calls)).not.toContain(test.title);
  });
});
