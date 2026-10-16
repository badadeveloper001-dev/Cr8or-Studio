import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), findFirst: vi.fn(), provider: vi.fn(),
  runtime: vi.fn(), authorizedRuntime: vi.fn(), revalidate: vi.fn(),
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { workspace: {
  findMany: mocks.findMany, findFirst: mocks.findFirst,
} } }));
vi.mock("@/lib/security/authorization", () => ({ authorizeRoute: async () => ({
  ok: true, session: { userId: "owner", role: "owner", provider: "private-session" },
}) }));
vi.mock("@/lib/security/auth", () => ({ revalidatePrivateOwnerSession: mocks.revalidate }));
vi.mock("@/lib/security/policy", () => ({ evaluatePolicyGuard: () => ({ allowed: true }) }));
vi.mock("@/lib/workspace/providers/daytona", () => ({ createDaytonaProvider: mocks.provider }));
vi.mock("@/lib/workspace/runtime-factory", () => ({ getWorkspaceRuntime: mocks.runtime }));
vi.mock("@/lib/workspace/authorized-runtime", () => ({ authorizedRuntime: mocks.authorizedRuntime }));

import { AmbiguousCloudProjectError, findReusableCloudProject } from "@/lib/workspace/cloud-projects";
import { createCloudProject, listCloudProjects, openCloudProject } from "@/lib/workspace/cloud-service";

const repositoryUrl = "https://github.com/owner/existing-repository";
const historical = {
  id: "preserved-workspace-id", projectId: "cloud-historical-local-dev-id",
  runtimeType: "cloud", provider: "daytona", providerWorkspaceId: "preserved-daytona-id",
  repositoryUrl, branch: "main", projectName: "Existing project", updatedAt: new Date("2026-01-01"),
};
const request = () => new NextRequest("http://localhost/api/workspaces", {
  method: "POST", headers: { origin: "http://localhost", "x-cr8or-auth": "1" },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CR8OR_PRIVATE_AUTH_ENABLED", "true");
  vi.stubEnv("CR8OR_WORKSPACE_MODE", "cloud");
  vi.stubEnv("DAYTONA_API_KEY", "synthetic-provider-key-not-used");
  mocks.findMany.mockResolvedValue([historical]);
  mocks.findFirst.mockResolvedValue(historical);
  mocks.authorizedRuntime.mockResolvedValue({ ok: true, runtime: {} });
  mocks.revalidate.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("registered cloud identities", () => {
  it("matches canonical repositories and an explicit branch without rewriting historical IDs", async () => {
    const found = await findReusableCloudProject(repositoryUrl, "main", "owner", "owner");
    expect(found).toEqual(historical);
    expect(mocks.findMany).toHaveBeenCalledWith({ where: {
      runtimeType: "cloud", repositoryUrl: { equals: repositoryUrl, mode: "insensitive" }, branch: "main",
    }, take: 2 });
  });

  it("rejects ambiguous repository matches instead of selecting an arbitrary runtime", async () => {
    mocks.findMany.mockResolvedValue([historical, { ...historical, projectId: "another-project", branch: "other" }]);
    await expect(findReusableCloudProject(repositoryUrl, undefined, "owner", "owner"))
      .rejects.toBeInstanceOf(AmbiguousCloudProjectError);
    expect((await openCloudProject(request(), repositoryUrl)).status).toBe(409);
    expect(mocks.authorizedRuntime).not.toHaveBeenCalled();
  });

  it("routes an owner clone request to the registered historical project without provisioning", async () => {
    const req = request();
    const response = await createCloudProject(req, { repositoryUrl, branch: "main" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ project: { projectId: historical.projectId } });
    expect(mocks.authorizedRuntime).toHaveBeenCalledWith(req, historical.projectId);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("keeps new provider provisioning blocked in private mode", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect((await createCloudProject(request(), { repositoryUrl, branch: "main" })).status).toBe(503);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.authorizedRuntime).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("rejects an unknown registered project before resolving a runtime", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect((await openCloudProject(request(), "unknown-project")).status).toBe(404);
    expect(mocks.authorizedRuntime).not.toHaveBeenCalled();
  });

  it("propagates session revocation from the shared runtime boundary", async () => {
    mocks.authorizedRuntime.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await openCloudProject(request(), historical.projectId)).status).toBe(401);
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("does not return project metadata after the owner session is revoked during the query", async () => {
    mocks.revalidate.mockResolvedValue(false);
    const response = await listCloudProjects(request());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(historical.providerWorkspaceId);
  });

  it("fails closed when project persistence is unavailable", async () => {
    mocks.findMany.mockRejectedValue(new Error("synthetic internal database details"));
    const response = await createCloudProject(request(), { repositoryUrl });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("internal database details");
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});
