import { promises as fs } from "node:fs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PrismaClientKnownRequestError, PrismaClientInitializationError, PrismaClientUnknownRequestError } from "@prisma/client/runtime/library";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import {
  ensureProjectsRoot,
  listProjectFiles,
  projectDirNameFromUrl,
  resolveProjectDir,
  scanRecentProjects,
  slugifyProjectName,
  toProjectRef,
} from "@/lib/projects/workspace";
import { authorizeRoute } from "@/lib/security/authorization";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { runSandboxedCommand, SandboxViolationError } from "@/lib/security/sandbox";
import { PROJECTS_ROOT } from "@/lib/workspace/shell";

import { cloudModeEnabled } from "@/lib/workspace/cloud-projects";
import { createCloudProject, listCloudProjects, openCloudProject } from "@/lib/workspace/cloud-service";
export const maxDuration = 300;

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("recent") }),
  z.object({
    action: z.literal("create"),
    name: z.string().trim().min(1).max(120),
    approvalId: z.string().uuid().optional(),
  }),
  z.object({
    action: z.literal("open"),
    path: z.string().trim().min(1).max(500),
  }),
  z.object({
    action: z.literal("clone"),
    repositoryUrl: z.string().trim().min(8).max(2048),
    approvalId: z.string().uuid().optional(),
  }),
]);

function isValidCloneUrl(url: string): boolean {
  const httpsForm = url.startsWith("https://");
  const sshForm = url.startsWith("git@") || url.startsWith("ssh://");
  if (!httpsForm && !sshForm) {
    return false;
  }
  if (/[\s"';`$&|<>\\]|\.\.|--/.test(url)) {
    return false;
  }
  if (httpsForm && url.includes("@")) {
    return false;
  }
  return true;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function handleOpen(rawPath: string, requestId: string): Promise<NextResponse> {
  const projectDir = resolveProjectDir(rawPath);
  if (!projectDir) {
    return errorResponse({
      status: 400,
      code: "FORBIDDEN",
      message: "Path is outside the projects workspace.",
      requestId,
    });
  }

  let stat;
  try {
    stat = await fs.stat(projectDir);
  } catch {
    return errorResponse({ status: 404, code: "NOT_FOUND", message: "Project not found.", requestId });
  }
  if (!stat.isDirectory()) {
    return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Path is not a project directory.", requestId });
  }

  const files = await listProjectFiles(projectDir);
  return NextResponse.json(
    {
      ok: true,
      project: {
        ...toProjectRef(projectDir),
        updatedAt: stat.mtime.toISOString(),
        files,
      },
    },
    { status: 200 },
  );
}

function policyDeniedResponse(
  reason: string,
  approvalRequired: boolean,
  profile: string,
  risk: string,
  action: string,
  preview: unknown,
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      message: reason,
      requiresApproval: approvalRequired,
      policy: { profile, risk, action },
      preview,
    },
    { status: 409 },
  );
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/projects/workspace", async (request: NextRequest, { requestId }) => {
  try {
    const raw = await request.json();
    const body = bodySchema.parse(raw);

    if (cloudModeEnabled()) {
      if (body.action === "recent") return await listCloudProjects(request);
      if (body.action === "open") return await openCloudProject(request, body.path);
      return await createCloudProject(request, body.action === "clone"
        ? { repositoryUrl: body.repositoryUrl, approvalId: body.approvalId }
        : { projectName: body.name, approvalId: body.approvalId });
    }

    if (body.action === "recent") {
      const auth = await authorizeRoute(request, {
        route: "api/projects/workspace:recent",
        minRole: "viewer",
        requestId,
      });
      if (!auth.ok) return auth.response;

      await ensureProjectsRoot();
      const projects = await scanRecentProjects();
      return NextResponse.json({ ok: true, projects }, { status: 200 });
    }

    if (body.action === "open") {
      const auth = await authorizeRoute(request, {
        route: "api/projects/workspace:open",
        minRole: "viewer",
        requestId,
      });
      if (!auth.ok) return auth.response;

      return handleOpen(body.path, requestId);
    }

    if (body.action === "create") {
      const auth = await authorizeRoute(request, {
        route: "api/projects/workspace:create",
        minRole: "maintainer",
        requestId,
      });
      if (!auth.ok) return auth.response;

      const slug = slugifyProjectName(body.name);
      if (!slug) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Project name could not be converted into a safe directory name.",
          requestId,
        });
      }

      const projectDir = resolveProjectDir(slug);
      if (!projectDir) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid project name.", requestId });
      }

      const preview = { action: "project.create", name: body.name, path: `projects/${slug}` };
      const policy = evaluatePolicyGuard({
        action: "project.create",
        requestId,
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        approvalId: body.approvalId,
      });
      if (!policy.allowed) {
        return policyDeniedResponse(policy.reason, policy.approvalRequired, policy.profile, policy.risk, "project.create", preview);
      }

      await ensureProjectsRoot();
      try {
        await fs.mkdir(projectDir);
      } catch {
        return errorResponse({
          status: 409,
          code: "CONFLICT",
          message: `Project "${slug}" already exists.`,
          requestId,
        });
      }

      const files = await listProjectFiles(projectDir);
      return NextResponse.json(
        {
          ok: true,
          project: {
            ...toProjectRef(projectDir),
            updatedAt: new Date().toISOString(),
            files,
          },
        },
        { status: 201 },
      );
    }

    const auth = await authorizeRoute(request, {
      route: "api/projects/workspace:clone",
      minRole: "maintainer",
      requestId,
    });
    if (!auth.ok) return auth.response;

    if (!isValidCloneUrl(body.repositoryUrl)) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Invalid repository URL. Use an https:// or SSH GitHub URL without embedded credentials or shell metacharacters.",
        requestId,
      });
    }

    const slug = slugifyProjectName(projectDirNameFromUrl(body.repositoryUrl));
    if (!slug) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Could not derive a safe project directory name from the repository URL.",
        requestId,
      });
    }

    const projectDir = resolveProjectDir(slug);
    if (!projectDir) {
      return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid repository URL.", requestId });
    }

    if (await pathExists(projectDir)) {
      return errorResponse({
        status: 409,
        code: "CONFLICT",
        message: `Project directory "projects/${slug}" already exists. Refusing to overwrite it.`,
        requestId,
      });
    }

    const preview = { action: "project.clone", repositoryUrl: body.repositoryUrl, path: `projects/${slug}` };
    const policy = evaluatePolicyGuard({
      action: "project.clone",
      requestId,
      actorId: auth.session.userId,
      actorRole: auth.session.role,
      approvalId: body.approvalId,
    });
    if (!policy.allowed) {
      return policyDeniedResponse(policy.reason, policy.approvalRequired, policy.profile, policy.risk, "project.clone", preview);
    }

    await ensureProjectsRoot();
    try {
      await runSandboxedCommand({
        command: `git clone ${JSON.stringify(body.repositoryUrl)} ${JSON.stringify(slug)}`,
        cwd: PROJECTS_ROOT,
        workspaceId: `projects/${slug}`,
        route: "api/projects/workspace:clone",
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        requestId,
        allowedRoots: [PROJECTS_ROOT],
        allowedCommands: [{ kind: "prefix", value: "git clone " }],
        timeoutMs: 300000,
      });
    } catch (error) {
      if (error instanceof SandboxViolationError) {
        return errorResponse({
          status: error.status,
          code: "FORBIDDEN",
          message: error.message,
          requestId,
        });
      }
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: error instanceof Error ? `Clone failed: ${error.message}` : "Clone failed.",
        requestId,
      });
    }

    if (!(await pathExists(projectDir))) {
      return internalErrorResponse("Clone completed but the project directory was not found.", requestId);
    }

    const files = await listProjectFiles(projectDir);
    return NextResponse.json(
      {
        ok: true,
        project: {
          ...toProjectRef(projectDir),
          files,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SandboxViolationError) {
      return errorResponse({
        status: error.status,
        code: "FORBIDDEN",
        message: error.message,
        requestId,
      });
    }
    if (error instanceof z.ZodError) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Invalid project workspace request.",
        details: error.issues,
        requestId,
      });
    }
    if (error instanceof PrismaClientKnownRequestError) {
      console.error(`[db-error] requestId=${requestId} prismaCode=${error.code} operation=projects/workspace`);
      return internalErrorResponse("Cloud workspace database error.", requestId);
    }
    if (error instanceof PrismaClientInitializationError) {
      console.error(`[db-error] requestId=${requestId} prismaCode=P1001 operation=projects/workspace`);
      return internalErrorResponse("Cr8or could not connect to its workspace database.", requestId);
    }
    if (error instanceof PrismaClientUnknownRequestError) {
      const msg = error instanceof Error ? error.message : "";
      const isConn = msg.includes("Can't reach database server") || msg.includes("ECONNREFUSED");
      console.error(`[db-error] requestId=${requestId} prismaCode=${isConn ? "P1001" : "P5000"} operation=projects/workspace`);
      return internalErrorResponse(isConn ? "Cr8or could not connect to its workspace database." : "Cloud workspace database error.", requestId);
    }
    return internalErrorResponse("Project workspace operation failed.", requestId);
  }
  })(request);
}