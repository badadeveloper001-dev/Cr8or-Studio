import { describe, expect, it } from "vitest";

import {
  buildGitOperationScope, canonicalGitRepository, GIT_MAX_CONTENT_BYTES, GIT_OPERATION_KEYS,
  gitScopeDigest, isGithubOperation, isGitMutation, parseGitOperation, validateGitOperationScope,
  validGitPath, validGitRef,
} from "@/lib/security/git-operation-catalogue";
import { ExecutionAuthorizationError, type ExecutionWorkspace } from "@/lib/security/execution-context";

const head = "a".repeat(40), otherHead = "b".repeat(40), index = "c".repeat(64);
const workspace: ExecutionWorkspace = {
  id: "workspace-record-a", runtimeType: "cloud", provider: "daytona", providerWorkspaceId: "sandbox-a",
  repositoryUrl: "https://github.com/Fixture/Project-A.git", branch: "main",
};
const context = { projectId: "project-a", workspace };
const namedContext = { ...context, workspace: { ...workspace, repositoryUrl: "https://github.com/badadeveloper001-dev/Cr8or-Studio.git" } };
const localMutation = { branch: "main", expectedHead: head, expectedIndex: index };
const remoteMutation = { branch: "main", expectedRemoteHead: head };
const pullRequest = { operation: "create-pr", ...remoteMutation, baseBranch: "review", expectedBase: otherHead, category: "General maintenance" };
it("rejects malformed UTF-8 paths before provider dispatch", () => {
  expect(validGitPath("src/\ud800.ts")).toBe(false);
  expect(() => parseGitOperation({ operation: "diff", paths: ["src/\ud800.ts"] })).toThrow();
});
const update = { operation: "upsert-file", ...remoteMutation, filePath: "src/app.ts", expectedBlob: null,
  content: "const message = '😀 café';\n", category: "Code improvements" };
const examples = [
  ...["status", "branch", "changes", "log", "remote", "list-branches"].map(operation => ({ operation })),
  { operation: "diff", paths: ["src/app.ts"], staged: true },
  { operation: "stage", ...localMutation, paths: ["src/app.ts"] },
  { operation: "unstage", ...localMutation, paths: ["src/app.ts"] },
  { operation: "commit", ...localMutation, category: "General maintenance" },
  { operation: "push", ...remoteMutation, targetCommit: otherHead },
  { operation: "create-branch", ...remoteMutation, targetBranch: "feature/new", targetCommit: head },
  { operation: "create-pr", ...remoteMutation, baseBranch: "review", expectedBase: otherHead, category: "Test improvements" },
  update, { operation: "list-contents", filePath: "src" },
  { operation: "read-file", filePath: "src/app.ts" }, { operation: "pr-checks", pullNumber: 7 },
];

describe("trusted Git operation catalogue", () => {
  it.each(examples)("accepts the exact bounded $operation contract", request => {
    expect(parseGitOperation(request)).toEqual(request);
    expect(Object.isFrozen(parseGitOperation(request))).toBe(true);
  });

  it("covers every catalogue operation exactly once", () => {
    expect(examples.map(request => request.operation).sort()).toEqual([...GIT_OPERATION_KEYS].sort());
  });

  it.each([undefined, null, "git status", {}, { operation: "status && cat .env" }, { operation: "$(git status)" },
    { operation: "status", args: ["--exec=evil"] }, { operation: "status", cwd: "/other" },
    { operation: "status", env: { GIT_CONFIG_GLOBAL: "/unsafe" } }, { operation: "status", repositoryKey: "other/repo" },
    { operation: "commit", ...localMutation, category: "Security weakness details" },
    { operation: "push", branch: "main", targetCommit: head },
    { operation: "push", ...remoteMutation, targetCommit: head, force: true },
    { operation: "create-pr", ...remoteMutation, baseBranch: "review", category: "Code improvements" },
  ])("rejects arbitrary, incomplete or caller-configured operations %#", request => {
    expect(() => parseGitOperation(request)).toThrow(ExecutionAuthorizationError);
  });

  it("marks every local and remote mutation as write authority", () => {
    for (const key of ["stage", "unstage", "commit", "push", "create-branch", "create-pr", "upsert-file"]) expect(isGitMutation(key)).toBe(true);
    for (const key of ["status", "diff", "log", "remote", "read-file", "list-branches", "arbitrary"]) expect(isGitMutation(key)).toBe(false);
    expect(isGithubOperation("push")).toBe(true);
    expect(isGithubOperation("stage")).toBe(false);
  });

  it.each([{ title: "CR8OR-012: General maintenance" }, { projectCode: "FORGED" }, { sequence: 12 },
    { pullRequestNaming: { version: 2, projectCode: "CR8OR", strategy: "approved-head-commit" } }])(
    "rejects caller-supplied pull-request naming metadata %#", fields => {
      expect(() => parseGitOperation({ ...pullRequest, ...fields })).toThrow(ExecutionAuthorizationError);
    },
  );

  it.each(["commit", "upsert-file"] as const)("rejects client naming metadata for %s", operation => {
    const request = operation === "commit" ? { operation, ...localMutation, category: "General maintenance" } : update;
    for (const fields of [{ projectCode: "FORGED" }, { sequence: 1 }, { title: "CR8OR-001: General maintenance" },
      { commitNaming: { version: 1, projectCode: "CR8OR", strategy: "registered-history-next" } }]) {
      expect(() => parseGitOperation({ ...request, ...fields })).toThrow(ExecutionAuthorizationError);
    }
  });

  it.each(["", "-main", "main;id", "$(id)", "main\nsecret", "main branch", "../main", "main..old", "a//b", "a/.hidden", "a/b.lock", "refs/heads/main", "HEAD", "main.", "a".repeat(201)])(
    "rejects unsafe Git reference %j", value => expect(validGitRef(value)).toBe(false),
  );
  it.each(["main", "feature/new-ui", "CR8OR-011", "release/v1.2.3"])("accepts reference %s", value => expect(validGitRef(value)).toBe(true));

  it.each(["", "/etc/passwd", "../file", "src/../../file", "src//file", "src/./file", "-file", "a\\b", "a\0b", "a\nb", ":(glob)*", "src/*.ts", ".git/config", "src/.env", ".env.local", ".ssh/config", ".aws/credentials", ".npmrc", ".netrc", "id_rsa", "id_ed25519", "a".repeat(4097)])(
    "rejects unsafe or sensitive file scope %j", value => expect(validGitPath(value)).toBe(false),
  );
  it.each(["src/app.ts", "docs/hello world.md", "src/café.ts", "README.md"])("accepts relative file scope %s", value => expect(validGitPath(value)).toBe(true));

  it("bounds aggregate file scope and freezes parsed paths", () => {
    for (const paths of [[], ["src/app.ts", "src/app.ts"], Array.from({ length: 65 }, (_, n) => `src/${n}.ts`),
      Array.from({ length: 5 }, (_, n) => `${n}${"x".repeat(4090)}`)]) {
      expect(() => parseGitOperation({ operation: "diff", paths })).toThrow();
    }
    const request = parseGitOperation({ operation: "diff", paths: ["src/app.ts"] });
    if (!("paths" in request)) throw new Error("Expected paths");
    expect(Object.isFrozen(request.paths)).toBe(true);
    expect(() => request.paths.push("other.ts")).toThrow();
  });

  it("bounds content by UTF-8 bytes without trimming, normalizing or breaking Unicode", () => {
    const content = "\uFEFF  café 😀\r\n";
    expect(parseGitOperation({ ...update, content })).toHaveProperty("content", content);
    expect(parseGitOperation({ ...update, content: "" })).toHaveProperty("content", "");
    expect(() => parseGitOperation({ ...update, content: "x".repeat(GIT_MAX_CONTENT_BYTES) })).not.toThrow();
    for (const oversized of ["x".repeat(GIT_MAX_CONTENT_BYTES + 1), "é".repeat(GIT_MAX_CONTENT_BYTES / 2 + 1), "\uD800", "\uDC00"]) {
      expect(() => parseGitOperation({ ...update, content: oversized })).toThrow();
    }
  });
});

describe("registered Git repository and operation scopes", () => {
  it.each(["https://github.com/Fixture/Project-A.git", "https://github.com/fixture/project-a", "git@github.com:Fixture/Project-A.git"])(
    "canonicalizes supported registered repository %s", url => {
      expect(canonicalGitRepository(url)).toEqual({ key: "fixture/project-a", owner: "fixture", repo: "project-a", url: "https://github.com/fixture/project-a.git" });
    },
  );
  it.each(["https://secret-token@github.com/fixture/repo", "https://user:secret@github.com/fixture/repo", "https://github.com/fixture/repo?token=secret", "https://github.com/fixture/repo#secret", "https://github.com:443/fixture/repo", "http://github.com/fixture/repo", "ssh://git@github.com/fixture/repo", "file:///tmp/repo", "https://other.example/fixture/repo", "https://github.com/fixture/../repo", "https://github.com/fixture/repo/", "https://github.com/fixture/."])(
    "rejects credential-bearing or unsupported repository %s without reflecting it", url => {
      let error: unknown;
      try { canonicalGitRepository(url); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ExecutionAuthorizationError);
      expect(String(error)).not.toContain(url);
      expect(String(error)).not.toContain("secret");
    },
  );

  it("derives identity only from the registered context and excludes source content", () => {
    const scope = buildGitOperationScope(namedContext, parseGitOperation(update));
    expect(scope).toMatchObject({ ownerId: "owner", projectId: "project-a", workspaceRecordId: "workspace-record-a",
      providerWorkspaceId: "sandbox-a", repositoryKey: "badadeveloper001-dev/cr8or-studio", branch: "main", filePath: "src/app.ts", operationKey: "upsert-file" });
    expect(JSON.stringify(scope)).not.toContain(update.content);
    expect(scope.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes an omitted read branch to the registered branch", () => {
    expect(buildGitOperationScope(context, parseGitOperation({ operation: "status" })))
      .toEqual(buildGitOperationScope(context, parseGitOperation({ operation: "status", branch: "main" })));
  });

  it("rejects branch substitution and incomplete runtime registration", () => {
    expect(() => buildGitOperationScope(context, parseGitOperation({ operation: "status", branch: "other" }))).toThrow();
    for (const replacement of [{ id: null }, { runtimeType: "local" as const }, { provider: "other" },
      { providerWorkspaceId: null }, { repositoryUrl: null }, { branch: null }]) {
      expect(() => buildGitOperationScope({ ...context, workspace: { ...workspace, ...replacement } }, parseGitOperation({ operation: "status" }))).toThrow();
    }
  });

  it("binds payload digests to exact contents, target commit and file scope", () => {
    const base = buildGitOperationScope(namedContext, parseGitOperation(update));
    for (const replacement of [{ content: "different" }, { filePath: "src/other.ts" }, { expectedBlob: otherHead },
      { expectedRemoteHead: otherHead }, { category: "Test improvements" }]) {
      const changed = buildGitOperationScope(namedContext, parseGitOperation({ ...update, ...replacement }));
      expect(changed.payloadDigest).not.toBe(base.payloadDigest);
      expect(gitScopeDigest(changed)).not.toBe(gitScopeDigest(base));
    }
    const pull = { operation: "create-pr", ...remoteMutation, baseBranch: "review", expectedBase: head, category: "Code improvements" };
    expect(buildGitOperationScope(namedContext, parseGitOperation(pull)).payloadDigest)
      .not.toBe(buildGitOperationScope(namedContext, parseGitOperation({ ...pull, expectedBase: otherHead })).payloadDigest);
  });

  it("binds pull-request naming to the trusted repository mapping and immutable approved head", () => {
    const scope = buildGitOperationScope(namedContext, parseGitOperation(pullRequest));
    expect(scope.pullRequestNaming).toEqual({ version: 2, projectCode: "CR8OR", strategy: "approved-head-commit" });
    expect(scope.repositoryKey).toBe("badadeveloper001-dev/cr8or-studio");
    expect(scope.expectedRemoteHead).toBe(head);
    expect(Object.isFrozen(scope.pullRequestNaming)).toBe(true);
    expect(() => { scope.pullRequestNaming!.projectCode = "OTHER"; }).toThrow();
    expect(() => { scope.paths.push("other.ts"); }).toThrow();
  });

  it.each(["https://github.com/other-owner/Cr8or-Studio", "https://github.com/badadeveloper001-dev/other-project",
    "https://github.com/Fixture/Project-A.git"])("never guesses a project code for unrelated repository %s", repositoryUrl => {
    try {
      buildGitOperationScope({ ...context, workspace: { ...workspace, repositoryUrl } }, parseGitOperation(pullRequest));
      throw new Error("Expected rejection");
    } catch (error) { expect(error).toMatchObject({ status: 409, message: "Registered project naming is unavailable." }); }
  });

  it.each([undefined, { version: 1, projectCode: "CR8OR", strategy: "approved-head-successor" },
    { version: 2, projectCode: "OTHER", strategy: "approved-head-commit" },
    { version: 2, projectCode: "CR8OR", strategy: "next-available" },
    { version: 2, projectCode: "CR8OR", strategy: "approved-head-commit", sequence: 12 },
  ])("invalidates missing, altered or unsupported pull-request naming %#", pullRequestNaming => {
    const scope = buildGitOperationScope(namedContext, parseGitOperation(pullRequest));
    expect(() => validateGitOperationScope({ ...scope, pullRequestNaming })).toThrow(ExecutionAuthorizationError);
  });

  it.each(["expectedRemoteHead", "expectedBase", "baseBranch", "category"] as const)(
    "rejects incomplete approved pull-request derivation missing %s", field => {
      const scope = buildGitOperationScope(namedContext, parseGitOperation(pullRequest));
      expect(() => validateGitOperationScope({ ...scope, [field]: null })).toThrow(ExecutionAuthorizationError);
    },
  );

  it("binds naming and title inputs to approval digests without changing unrelated scope shapes", () => {
    const scope = buildGitOperationScope(namedContext, parseGitOperation(pullRequest));
    for (const replacement of [{ expectedRemoteHead: otherHead }, { category: "Test improvements" },
      { expectedBase: head }, { baseBranch: "other-review" }]) {
      const changed = buildGitOperationScope(namedContext, parseGitOperation({ ...pullRequest, ...replacement }));
      expect(gitScopeDigest(changed)).not.toBe(gitScopeDigest(scope));
    }
    expect(() => validateGitOperationScope({ ...scope, repositoryKey: "unrelated/project" })).toThrow();
    const unrelated = buildGitOperationScope(namedContext, parseGitOperation(update));
    expect(unrelated).not.toHaveProperty("pullRequestNaming");
    expect(() => validateGitOperationScope({ ...unrelated, pullRequestNaming: scope.pullRequestNaming })).toThrow();
  });

  it.each(["commit", "upsert-file"] as const)("binds trusted project naming and immutable mutation inputs for %s", operation => {
    const request = parseGitOperation(operation === "commit" ? { operation, ...localMutation, category: "General maintenance" } : update);
    const scope = buildGitOperationScope(namedContext, request);
    expect(scope.commitNaming).toEqual({ version: 1, projectCode: "CR8OR", strategy: "registered-history-next" });
    expect(Object.isFrozen(scope.commitNaming)).toBe(true);
    expect(() => { scope.commitNaming!.projectCode = "OTHER"; }).toThrow();
    expect(scope).not.toHaveProperty("pullRequestNaming");
    for (const commitNaming of [undefined, { version: 0, projectCode: "CR8OR", strategy: "registered-history-next" },
      { version: 1, projectCode: "PROJECT", strategy: "registered-history-next" },
      { version: 1, projectCode: "CR8OR", strategy: "next-available" },
      { version: 1, projectCode: "CR8OR", strategy: "registered-history-next", sequence: 1 }]) {
      expect(() => validateGitOperationScope({ ...scope, commitNaming })).toThrow(ExecutionAuthorizationError);
    }
    const relevantFields = operation === "commit" ? ["expectedHead", "expectedIndex", "category"] :
      ["expectedRemoteHead", "filePath", "contentDigest", "category"];
    for (const field of relevantFields) {
      expect(() => validateGitOperationScope({ ...scope, [field]: null })).toThrow(ExecutionAuthorizationError);
    }
    const changed = buildGitOperationScope(namedContext, parseGitOperation({ ...request, category: "Test improvements" }));
    expect(gitScopeDigest(changed)).not.toBe(gitScopeDigest(scope));
    expect(() => buildGitOperationScope(context, request)).toThrow("Registered project naming is unavailable.");
    expect(() => validateGitOperationScope({ ...scope, repositoryKey: "unrelated/project" })).toThrow();
  });

  it.each(["status", "stage", "create-pr"] as const)("does not add commit allocation semantics to %s", operation => {
    const request = parseGitOperation(operation === "stage" ? { operation, ...localMutation, paths: ["src/app.ts"] } :
      operation === "create-pr" ? pullRequest : { operation });
    const scope = buildGitOperationScope(namedContext, request);
    expect(scope).not.toHaveProperty("commitNaming");
    expect(() => validateGitOperationScope({ ...scope,
      commitNaming: { version: 1, projectCode: "CR8OR", strategy: "registered-history-next" } })).toThrow();
  });

  it("binds digest to project, workspace, repository, branch and full structured scope", () => {
    const base = buildGitOperationScope(context, parseGitOperation({ operation: "status" }));
    for (const replacement of [{ projectId: "project-b" }, { providerWorkspaceId: "sandbox-b" }, { workspaceRecordId: "workspace-record-b" },
      { repositoryKey: "fixture/project-b" }, { branch: "other" }, { operationKey: "log" as const }]) {
      expect(gitScopeDigest({ ...base, ...replacement })).not.toBe(gitScopeDigest(base));
    }
    expect(() => validateGitOperationScope({ ...base, ownerId: "attacker" })).toThrow();
    expect(() => validateGitOperationScope({ ...base, sessionId: "forged" })).toThrow();
    expect(() => validateGitOperationScope({ ...base, paths: Array.from({ length: 8 }, (_, n) => `${n}${"x".repeat(4090)}`) })).toThrow();
  });
});
