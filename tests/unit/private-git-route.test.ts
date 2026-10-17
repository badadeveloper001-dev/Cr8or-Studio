import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), context: vi.fn(), scope: vi.fn(), mode: vi.fn(), secret: vi.fn(), shell: vi.fn(),
}));
vi.mock("@/lib/security/authorization", () => ({ authorizeRoute: mocks.authorize }));
vi.mock("@/lib/security/private-auth-mode", () => ({ getPrivateAuthMode: mocks.mode }));
vi.mock("@/lib/security/git-authorization", () => ({ validateGitRepositoryContext: mocks.scope }));
vi.mock("@/lib/security/secrets", () => ({ getSecretWithFallback: mocks.secret }));
vi.mock("@/lib/security/sandbox", () => ({ runSandboxedCommand: mocks.shell, SandboxViolationError: class extends Error {} }));
vi.mock("@/lib/security/execution-context", () => ({
  createExecutionAuthorization: mocks.context,
  ExecutionAuthorizationError: class extends Error {
    constructor(readonly status: number, message = "Git operation is not authorized.") { super(message); }
  },
}));

import { POST as gitPOST } from "@/app/api/github/ops/route";
import { POST as githubPOST } from "@/app/api/github/api/route";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";

const session = Object.freeze({ userId: "owner", role: "owner", provider: "private-session", authenticated: true });
const context = Object.freeze({ ownerId: "owner", projectId: "project-a", workspace: { providerWorkspaceId: "sandbox-a" } });
const scope = Object.freeze({ projectId: "project-a", repositoryKey: "fixture/repo-a", providerWorkspaceId: "sandbox-a" });
const sha = "a".repeat(40);
const index = "b".repeat(64);
const localBody = { projectId: "project-a", operation: { operation: "status" } };
const remoteBody = { projectId: "project-a", operation: { operation: "list-branches" } };

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://studio.example.test/api/github/ops", {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: "https://studio.example.test", "x-cr8or-auth": "1", ...headers },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode.mockReturnValue("required");
  mocks.authorize.mockResolvedValue({ ok: true, session });
  mocks.context.mockResolvedValue(context);
  mocks.scope.mockResolvedValue(scope);
});
afterEach(() => vi.unstubAllEnvs());

describe.each([
  ["Daytona Git", gitPOST, localBody], ["GitHub API", githubPOST, remoteBody],
] as const)("private %s route", (_name, post, validBody) => {
  it("resolves the owner and registered project before the immutable release restriction", async () => {
    const response = await post(request(validBody));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.context).toHaveBeenCalledExactlyOnceWith(session, "project-a", expect.objectContaining({ permissions: ["read"] }));
    expect(mocks.scope).toHaveBeenCalledExactlyOnceWith(context, validBody.operation);
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it.each([401, 503])("rejects authorization failure %s before body parsing or sensitive work", async status => {
    mocks.authorize.mockResolvedValue({ ok: false, response: new Response(null, { status }) });
    const malformed = new NextRequest("https://studio.example.test/api/github/api", { method: "POST", body: "not JSON" });
    expect((await post(malformed)).status).toBe(status);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it.each(["owner", "repo", "ownerId", "sessionId", "providerWorkspaceId", "projectPath", "actorRole", "approved", "commandRules"])(
    "rejects client authority field %s", async field => {
      expect((await post(request({ ...validBody, [field]: "forged" }))).status).toBe(400);
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.secret).not.toHaveBeenCalled();
      expect(mocks.shell).not.toHaveBeenCalled();
    },
  );

  it("requires the canonical project selector and rejects legacy arbitrary repository contracts", async () => {
    expect((await post(request({ action: "status", projectPath: "../../another-project", owner: "other", repo: "private" }))).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 503] as const)("preserves registered-scope rejection %s without provider work", async status => {
    mocks.scope.mockRejectedValue(new ExecutionAuthorizationError(status));
    expect((await post(request(validBody))).status).toBe(status);
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it("rejects missing context instead of treating a supplied project as authorization", async () => {
    mocks.context.mockResolvedValue(undefined);
    expect((await post(request(validBody))).status).toBe(401);
    expect(mocks.scope).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected infrastructure errors", async () => {
    mocks.scope.mockRejectedValue(new Error("provider-token private-source postgres://secret:password@host"));
    const response = await post(request(validBody));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/provider-token|private-source|password/);
  });

  it.each<Record<string, string>>([
    { "Content-Type": "text/plain" }, { "Content-Encoding": "gzip" },
    { "Content-Length": "invalid" }, { "Content-Length": "1" },
  ])("rejects invalid request transport %j", async headers => {
    expect((await post(request(validBody, headers))).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("bounds declared and streamed payloads", async () => {
    expect((await post(request(validBody, { "Content-Length": "2097153" }))).status).toBe(413);
    expect((await post(request({ ...validBody, content: "x".repeat(2097153) }))).status).toBe(413);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("cannot enable private dispatch through environment flags or an approval identifier", async () => {
    vi.stubEnv("CR8OR_PRIVATE_GIT_ENABLED", "true");
    vi.stubEnv("CR8OR_PRIVATE_COMMAND_ENABLED", "true");
    const response = await post(request({ ...validBody, approvalId: "040d4c78-d767-4199-a662-15db78c138d9" }));
    expect(response.status).toBe(503);
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.shell).not.toHaveBeenCalled();
  });
});

describe("private Git operation contracts", () => {
  it.each([
    { operation: "status; cat .env" }, { operation: "status", args: ["--config=credential.helper=evil"] },
    { operation: "diff", paths: ["../.env"] }, { operation: "diff", paths: ["--output=/tmp/private"] },
    { operation: "branch", branch: "$(cat .env)" }, { operation: "status", cwd: "/other" },
  ])("rejects unsafe local operation %j", async operation => {
    expect((await gitPOST(request({ ...localBody, operation }))).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("does not let local and GitHub operation families select each other's execution paths", async () => {
    expect((await gitPOST(request(remoteBody))).status).toBe(400);
    expect((await githubPOST(request(localBody))).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("requires write permission for a local Git mutation", async () => {
    expect((await gitPOST(request({ projectId: "project-a", operation: {
      operation: "stage", paths: ["src/app.ts"], branch: "main", expectedHead: sha, expectedIndex: index,
    } }))).status).toBe(503);
    expect(mocks.context).toHaveBeenCalledWith(session, "project-a", expect.objectContaining({ permissions: ["write"] }));
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it("requires write permission and exact expected targets for a GitHub mutation", async () => {
    expect((await githubPOST(request({ projectId: "project-a", operation: {
      operation: "push", branch: "main", expectedRemoteHead: sha, targetCommit: "c".repeat(40),
    } }))).status).toBe(503);
    expect(mocks.context).toHaveBeenCalledWith(session, "project-a", expect.objectContaining({ permissions: ["write"] }));
    expect(mocks.secret).not.toHaveBeenCalled();
  });

  it("preserves inactive GitHub behavior", async () => {
    mocks.mode.mockReturnValue("inactive");
    mocks.secret.mockReturnValue({ value: null });
    expect((await githubPOST(request({ action: "list-repos" }))).status).toBe(400);
    expect(mocks.secret).toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
  });
});
