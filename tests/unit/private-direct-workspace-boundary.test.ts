import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), command: vi.fn(), root: vi.fn(), files: vi.fn(), recent: vi.fn(), provider: vi.fn(),
}));
vi.mock("@/lib/security/session-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security/session-store")>(), resolveOwnerSession: mocks.session,
}));
vi.mock("@/lib/security/sandbox", () => ({
  runSandboxedCommand: mocks.command, SandboxViolationError: class extends Error {},
}));
vi.mock("@/lib/workspace/providers/daytona", () => ({
  createDaytonaProvider: mocks.provider, DaytonaProvider: class { constructor() { mocks.provider(); } },
}));
vi.mock("@/lib/projects/workspace", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/projects/workspace")>(),
  ensureProjectsRoot: mocks.root, listProjectFiles: mocks.files, scanRecentProjects: mocks.recent,
}));

import { POST as deploy } from "@/app/api/deploy/route";
import { POST as git } from "@/app/api/github/ops/route";
import { POST as preview } from "@/app/api/workspaces/[projectId]/preview/route";
import { POST as workspace } from "@/app/api/projects/workspace/route";

const origin = "http://localhost:3000";
const token = Buffer.alloc(32, 23).toString("base64url");
function request(path: string, body: unknown, protectedOrigin = true) {
  return new NextRequest(`${origin}${path}`, {
    method: "POST",
    headers: { cookie: `cr8or-dev-session=${token}`, ...(protectedOrigin ? { origin, "x-cr8or-auth": "1" } : {}) },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "true");
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ORIGIN", origin);
  vi.stubEnv("CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY", Buffer.alloc(32, 24).toString("base64url"));
  vi.stubEnv("CR8OR_FEATURE_AUTH_GUARD", "false");
  vi.stubEnv("CR8OR_WORKSPACE_MODE", "local");
  for (const name of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) vi.stubEnv(name, undefined);
  mocks.session.mockResolvedValue({
    id: "synthetic-session", ownerId: "owner", credentialVersion: 1, authenticationMethod: "ACCESS_CODE",
    authenticatedAt: new Date(), createdAt: new Date(), expiresAt: new Date(Date.now() + 60000), revokedAt: null, lastActiveAt: null,
  });
  mocks.recent.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("unsupported direct workspace execution in private mode", () => {
  const endpoints = [
    { path: "/api/deploy", invoke: (req: NextRequest) => deploy(req) },
    { path: "/api/github/ops", invoke: (req: NextRequest) => git(req) },
    { path: "/api/workspaces/test/preview", invoke: (req: NextRequest) => preview(req, { params: Promise.resolve({ projectId: "test" }) }) },
  ];
  it.each(endpoints)("blocks $path before parsing or executing work even for the authenticated owner", async ({ path, invoke }) => {
    const req = request(path, { action: "start", projectPath: "../../unregistered" });
    const parse = vi.spyOn(req, "json");
    const response = await invoke(req);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parse).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it.each([
    { action: "recent" }, { action: "open", path: "projects/unregistered" },
    { action: "create", name: "New project" }, { action: "clone", repositoryUrl: "https://github.com/example/project" },
  ])("blocks local directory management before filesystem work: $action", async (body) => {
    expect((await workspace(request("/api/projects/workspace", body))).status).toBe(503);
    for (const spy of [mocks.command, mocks.root, mocks.files, mocks.recent, mocks.provider]) expect(spy).not.toHaveBeenCalled();
  });

  it("preserves request-origin protection for management POSTs", async () => {
    expect((await workspace(request("/api/projects/workspace", { action: "recent" }, false))).status).toBe(400);
    expect(mocks.recent).not.toHaveBeenCalled();
  });

  it("preserves the existing local directory workflow while staging is deliberately inactive", async () => {
    for (const name of ["CR8OR_PRIVATE_AUTH_ENABLED", "CR8OR_PRIVATE_AUTH_ORIGIN", "CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY"]) vi.stubEnv(name, undefined);
    expect((await workspace(request("/api/projects/workspace", { action: "recent" }))).status).toBe(200);
    expect(mocks.root).toHaveBeenCalledOnce();
    expect(mocks.recent).toHaveBeenCalledOnce();
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
