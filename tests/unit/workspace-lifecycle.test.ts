import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkspaceLifecycleRequest, reservedLifecycleIdentity, validateWorkspaceLifecycleScope,
  workspaceLifecycleScopeDigest, type WorkspaceLifecycleScope } from "@/lib/security/workspace-lifecycle-catalogue";
import { assertPrivateRepositoryCloningAvailable, assertWorkspaceLifecycleAvailable } from "@/lib/workspace/private-workspace-lifecycle-availability";

const idempotencyKey = randomUUID();
const creation = () => ({ action: "create", projectName: "Synthetic project", idempotencyKey });
const scope = (): WorkspaceLifecycleScope => ({ version: 1, ownerId: "owner", action: "create", projectId: "cloud-reserved",
  workspaceRecordId: "workspace-reserved", providerWorkspaceId: null, projectName: "Synthetic project",
  repositoryKey: null, repositoryUrl: null, branch: null });
const registered = (): WorkspaceLifecycleScope => ({ ...scope(), action: "start", providerWorkspaceId: "sandbox-a",
  repositoryKey: "synthetic-owner/repository", repositoryUrl: "https://github.com/synthetic-owner/repository.git", branch: "main" });

afterEach(() => vi.unstubAllEnvs());

describe("workspace lifecycle trusted request and scope catalogue", () => {
  it.each([
    creation(),
    { action: "clone", repositoryUrl: "https://github.com/synthetic-owner/repository", branch: "main", idempotencyKey },
    { action: "start", projectId: "historical-project", idempotencyKey },
    { action: "stop", projectId: "historical-project", idempotencyKey },
  ])("accepts only the bounded supported action: $action", request => {
    const parsed = parseWorkspaceLifecycleRequest(request);
    expect(parsed).toEqual(request);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    { projectId: "client-selected" }, { workspaceRecordId: "client-selected" }, { providerWorkspaceId: "other-sandbox" },
    { ownerId: "owner" }, { sessionId: "forged" }, { credentialVersion: 1 }, { approvalStatus: "APPROVED" },
    { labels: { owner: "owner" } }, { shell: "npm test" }, { environment: { GITHUB_TOKEN: "secret" } },
    { snapshot: "arbitrary-snapshot" }, { operationId: randomUUID() },
  ])("rejects client authority and arbitrary provider configuration: %j", extra => {
    expect(() => parseWorkspaceLifecycleRequest({ ...creation(), ...extra })).toThrow();
  });
  it.each([
    null, {}, { ...creation(), action: "delete" }, { ...creation(), action: "recover" },
    { ...creation(), idempotencyKey: "unbounded-user-string" }, { ...creation(), projectName: "" },
    { ...creation(), projectName: " " }, { ...creation(), projectName: "x".repeat(121) },
    { ...creation(), projectName: "line\nbreak" },
    { action: "start", projectId: "", idempotencyKey }, { action: "stop", projectId: "x".repeat(257), idempotencyKey },
  ])("rejects malformed or unbounded lifecycle requests: %j", input => {
    expect(() => parseWorkspaceLifecycleRequest(input)).toThrow();
  });
  it.each([
    "https://attacker.invalid/owner/repo", "https://token@github.com/owner/repo", "git@github.com:owner/repo.git",
    "file:///etc/passwd", "https://github.com/owner/repo?token=secret", "https://github.com/owner/repo#token",
    "https://github.com/owner/../other", "https://github.com/owner/repo/extra",
  ])("rejects arbitrary or credential-bearing clone URL %s", repositoryUrl => {
    expect(() => parseWorkspaceLifecycleRequest({ action: "clone", repositoryUrl, branch: "main", idempotencyKey })).toThrow();
  });
  it.each(["--upload-pack=malicious", "../main", "main; echo secret", "main\nother", "refs/heads/../secret", "main~1"])(
    "rejects unsupported branch %s", branch => {
      expect(() => parseWorkspaceLifecycleRequest({ action: "clone", repositoryUrl: "https://github.com/owner/repo", branch, idempotencyKey })).toThrow();
    });
  it("derives deterministic isolated reservation identities without revealing the initiating session", () => {
    const first = reservedLifecycleIdentity("synthetic-session-a", idempotencyKey);
    expect(first).toEqual(reservedLifecycleIdentity("synthetic-session-a", idempotencyKey));
    expect(first).not.toEqual(reservedLifecycleIdentity("synthetic-session-b", idempotencyKey));
    expect(first).not.toEqual(reservedLifecycleIdentity("synthetic-session-a", randomUUID()));
    expect(first.projectId).toMatch(/^cloud-[a-f0-9]{32}$/);
    expect(first.workspaceRecordId).toMatch(/^workspace-[a-f0-9]{32}$/);
    expect(JSON.stringify(first)).not.toContain("synthetic-session");
  });
  it("freezes the canonical scope and hashes object ordering deterministically", () => {
    const value = validateWorkspaceLifecycleScope(scope());
    expect(Object.isFrozen(value)).toBe(true);
    const reversed = Object.fromEntries(Object.entries(value).reverse()) as WorkspaceLifecycleScope;
    expect(workspaceLifecycleScopeDigest(value)).toBe(workspaceLifecycleScopeDigest(reversed));
    expect(workspaceLifecycleScopeDigest(value)).toMatch(/^[a-f0-9]{64}$/);
    expect(workspaceLifecycleScopeDigest({ ...value, projectName: "Another project" })).not.toBe(workspaceLifecycleScopeDigest(value));
  });
  it.each([
    { ownerId: "other-owner" }, { projectId: "" }, { workspaceRecordId: "" }, { providerWorkspaceId: "client-selected" },
    { repositoryKey: "unrelated/repo" }, { repositoryUrl: "https://github.com/owner/repo.git" }, { branch: "main" },
    { action: "delete" }, { version: 2 }, { sessionId: "client-session" },
  ])("rejects incomplete or substituted provisioning scope: %j", changed => {
    expect(() => validateWorkspaceLifecycleScope({ ...scope(), ...changed })).toThrow();
  });
  it.each([
    { providerWorkspaceId: null }, { repositoryKey: "unrelated/repo" }, { branch: null },
    { repositoryUrl: "https://github.com/synthetic-owner/repository" },
    { repositoryUrl: "https://github.com/another/repository.git" },
  ])("rejects inconsistent registered lifecycle scope: %j", changed => {
    expect(() => validateWorkspaceLifecycleScope({ ...registered(), ...changed })).toThrow();
  });
  it("allows only a canonical repository, branch, and registered sandbox association", () => {
    expect(validateWorkspaceLifecycleScope(registered())).toEqual(registered());
  });
});

describe("private lifecycle release restrictions", () => {
  it.each([undefined, "true", "false"])("cannot enable lifecycle or clone using configuration %s", enabled => {
    vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", enabled);
    vi.stubEnv("CR8OR_PRIVATE_WORKSPACE_LIFECYCLE_ENABLED", "true");
    vi.stubEnv("CR8OR_POLICY_PROFILE", "autonomous");
    expect(() => assertWorkspaceLifecycleAvailable()).toThrow("pending provider verification");
    expect(() => assertPrivateRepositoryCloningAvailable()).toThrow("pending secure credential transport");
  });
});
