import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { authorizeRoute } from "@/lib/security/authorization";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { createDaytonaProvider } from "@/lib/workspace/providers/daytona";
import { CLOUD_REPOSITORY_ROOT } from "@/lib/workspace/cloud-path";
import { cloudModeEnabled, cloudOwnerDescription, cloudProjectId, cloudProjectRef, findCloudProject, parseRepository } from "@/lib/workspace/cloud-projects";
import { getWorkspaceRuntime } from "@/lib/workspace/runtime-factory";

const createSchema = z.object({
  repositoryUrl: z.string().optional(), projectName: z.string().trim().min(1).max(120).optional(),
  branch: z.string().trim().min(1).max(200).optional(), approvalId: z.string().uuid().optional(),
});

export async function listCloudProjects(request: NextRequest) {
  const auth = await authorizeRoute(request, { route: "api/workspaces", minRole: "viewer" });
  if (!auth.ok) return auth.response;
  if (!cloudModeEnabled()) return NextResponse.json({ ok: true, mode: "local", projects: [] });
  const workspaces = await prisma.workspace.findMany({
    where: { runtimeType: "cloud", ...(auth.session.role === "owner" ? {} : { project: { description: cloudOwnerDescription(auth.session.userId) } }) },
    orderBy: { updatedAt: "desc" }, take: 20,
  });
  return NextResponse.json({ ok: true, mode: "cloud", projects: workspaces.map(cloudProjectRef) });
}

export async function openCloudProject(request: NextRequest, value: string) {
  const auth = await authorizeRoute(request, { route: "api/workspaces:open", minRole: "viewer" });
  if (!auth.ok) return auth.response;
  const workspace = value.startsWith("https://")
    ? await prisma.workspace.findFirst({ where: { repositoryUrl: parseRepository(value).url, runtimeType: "cloud", ...(auth.session.role === "owner" ? {} : { project: { description: cloudOwnerDescription(auth.session.userId) } }) }, orderBy: { updatedAt: "desc" } })
    : await findCloudProject(value, auth.session.userId, auth.session.role);
  if (!workspace) return errorResponse({ status: 404, code: "NOT_FOUND", message: "Project not found. Clone the repository first, or choose a recent project." });
  await getWorkspaceRuntime(workspace.projectId);
  return NextResponse.json({ ok: true, project: cloudProjectRef(workspace) });
}

export async function createCloudProject(request: NextRequest, raw: unknown) {
  const auth = await authorizeRoute(request, { route: "api/workspaces:create", minRole: "maintainer" });
  if (!auth.ok) return auth.response;
  const body = createSchema.parse(raw);
  const repo = body.repositoryUrl ? parseRepository(body.repositoryUrl) : undefined;
  if (!repo && !body.projectName) return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Provide a repository URL or project name." });
  if (!process.env.DAYTONA_API_KEY) return errorResponse({ status: 409, code: "CONFLICT", message: "Cloud workspaces need DAYTONA_API_KEY on the server." });
  const action = repo ? "project.clone" : "project.create";
  const policy = evaluatePolicyGuard({ action, actorId: auth.session.userId, actorRole: auth.session.role, approvalId: body.approvalId });
  if (!policy.allowed) return NextResponse.json({ ok: false, message: policy.reason, requiresApproval: policy.approvalRequired, preview: { action, repositoryUrl: repo?.url }, policy: { action, profile: policy.profile, risk: policy.risk } }, { status: 409 });
  const projectId = repo ? cloudProjectId(auth.session.userId, repo.url, body.branch) : `cloud-${randomUUID()}`;
  const existing = await findCloudProject(projectId, auth.session.userId, auth.session.role);
  if (existing) {
    await getWorkspaceRuntime(projectId);
    return NextResponse.json({ ok: true, project: cloudProjectRef(existing) });
  }
  const name = body.projectName || repo!.repo;
  const provider = createDaytonaProvider({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
  const sandbox = await provider.createSandbox({ name: projectId });
  try {
    if (repo) {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      await sandbox.git.clone(repo.url, CLOUD_REPOSITORY_ROOT, body.branch, undefined, token ? "x-access-token" : undefined, token);
    } else {
      await sandbox.fs.createFolder(CLOUD_REPOSITORY_ROOT, "755");
    }
    const branch = repo ? (await sandbox.git.status(CLOUD_REPOSITORY_ROOT)).currentBranch : null;
    const project = await prisma.project.create({ data: {
      id: projectId, name, description: cloudOwnerDescription(auth.session.userId), framework: "unknown", language: "unknown", repository: repo?.url,
      workspaces: { create: { runtimeType: "cloud", provider: "daytona", providerWorkspaceId: sandbox.id, repositoryUrl: repo?.url, projectName: name, branch, state: "ready" } },
    }, include: { workspaces: true } });
    return NextResponse.json({ ok: true, project: cloudProjectRef(project.workspaces[0]) }, { status: 201 });
  } catch {
    await sandbox.delete().catch(() => undefined);
    return internalErrorResponse("Cloud project creation failed. Check repository access, Daytona availability, and database migrations.");
  }
}
