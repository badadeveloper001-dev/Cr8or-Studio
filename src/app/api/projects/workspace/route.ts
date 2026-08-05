import path from "node:path";
import { promises as fs } from "node:fs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { runSandboxedCommand, SandboxViolationError } from "@/lib/security/sandbox";
import { PROJECTS_ROOT, resolveWorkspacePath, sanitizeWorkspacePath, WORKSPACE_ROOT } from "@/lib/workspace/shell";

const bodySchema = z.object({
  action: z.enum(["create", "open", "clone", "recent"]),
  name: z.string().min(2).max(120).optional(),
  path: z.string().optional(),
  repositoryUrl: z.string().url().optional(),
  dryRun: z.boolean().optional(),
  approvalId: z.string().uuid().optional(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function readRecentProjects() {
  try {
    const dirs = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = await Promise.all(
      dirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const relPath = path.join("projects", entry.name);
          const absPath = path.join(PROJECTS_ROOT, entry.name);
          const stat = await fs.stat(absPath);
          return {
            name: entry.name,
            path: relPath.replace(/\\/g, "/"),
            updatedAt: stat.mtime.toISOString(),
          };
        }),
    );

    return projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch {
    return [];
  }
}

async function listFiles(projectAbsPath: string) {
  const items = await fs.readdir(projectAbsPath, { withFileTypes: true });
  return items.slice(0, 50).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "folder" : "file",
  }));
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/projects/workspace", async (request: NextRequest, { requestId }) => {
  try {
    await fs.mkdir(PROJECTS_ROOT, { recursive: true });
    const raw = await request.json();
    const payload = bodySchema.parse(raw);

    const minRole = payload.action === "open" || payload.action === "recent" ? "viewer" : "maintainer";
    const auth = await authorizeRoute(request, {
      route: "api/projects/workspace",
      minRole,
      requestId,
      requireWorkspaceOwnership: payload.action !== "recent",
    });
    if (!auth.ok) {
      return auth.response;
    }

    if (payload.action === "recent") {
      const projects = await readRecentProjects();
      return NextResponse.json({ projects }, { status: 200 });
    }

    if (payload.action === "create") {
      if (!payload.name) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Project name is required.", requestId });
      }

      const slug = slugify(payload.name);
      const relPath = path.join("projects", slug).replace(/\\/g, "/");
      const preview = {
        action: "project.create",
        name: payload.name,
        path: relPath,
      };

      if (payload.dryRun) {
        return NextResponse.json({ dryRun: true, preview }, { status: 200 });
      }

      const policy = evaluatePolicyGuard({
        action: "project.create",
        requestId,
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        approvalId: payload.approvalId,
      });
      if (!policy.allowed) {
        return NextResponse.json(
          {
            ok: false,
            message: policy.reason,
            requiresApproval: policy.approvalRequired,
            policy: {
              profile: policy.profile,
              risk: policy.risk,
              action: "project.create",
            },
            preview,
          },
          { status: 409 },
        );
      }
      const projectPath = resolveWorkspacePath(relPath);

      if (!projectPath) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid project path.", requestId });
      }

      await fs.mkdir(projectPath, { recursive: true });
      const readmePath = path.join(projectPath, "README.md");
      await fs.writeFile(readmePath, `# ${payload.name}\n\nCreated in Cr8or Studio.\n`, "utf8");

      return NextResponse.json(
        {
          project: {
            name: payload.name,
            path: relPath,
            files: await listFiles(projectPath),
          },
        },
        { status: 201 },
      );
    }

    if (payload.action === "open") {
      const safe = sanitizeWorkspacePath(payload.path ?? "");
      if (!safe) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid project path.", requestId });
      }
      const projectPath = resolveWorkspacePath(safe);
      if (!projectPath) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid project path.", requestId });
      }

      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Project path is not a directory.", requestId });
      }

      return NextResponse.json(
        {
          project: {
            name: path.basename(projectPath),
            path: safe,
            files: await listFiles(projectPath),
          },
        },
        { status: 200 },
      );
    }

    if (payload.action === "clone") {
      if (!payload.repositoryUrl) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Repository URL is required.", requestId });
      }

      const repoName = payload.repositoryUrl.split("/").pop()?.replace(/\.git$/, "") || "project";
      const safeName = slugify(payload.name || repoName || "project");
      const relPath = path.join("projects", safeName).replace(/\\/g, "/");
      const preview = {
        action: "project.clone",
        repositoryUrl: payload.repositoryUrl,
        path: relPath,
      };

      if (payload.dryRun) {
        return NextResponse.json({ dryRun: true, preview }, { status: 200 });
      }

      const policy = evaluatePolicyGuard({
        action: "project.clone",
        requestId,
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        approvalId: payload.approvalId,
      });
      if (!policy.allowed) {
        return NextResponse.json(
          {
            ok: false,
            message: policy.reason,
            requiresApproval: policy.approvalRequired,
            policy: {
              profile: policy.profile,
              risk: policy.risk,
              action: "project.clone",
            },
            preview,
          },
          { status: 409 },
        );
      }

      const projectPath = resolveWorkspacePath(relPath);
      if (!projectPath) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid clone destination.", requestId });
      }

      try {
        await fs.stat(projectPath);
        return errorResponse({ status: 409, code: "CONFLICT", message: "Destination already exists.", requestId });
      } catch {
        // expected if folder does not exist
      }

      await runSandboxedCommand({
        command: `git clone ${payload.repositoryUrl} ${projectPath}`,
        cwd: WORKSPACE_ROOT,
        workspaceId: relPath,
        route: "api/projects/workspace:clone",
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        requestId,
        allowedRoots: [WORKSPACE_ROOT],
        allowedCommands: [{ kind: "prefix", value: "git clone " }],
      });

      return NextResponse.json(
        {
          project: {
            name: safeName,
            path: relPath,
            files: await listFiles(projectPath),
          },
        },
        { status: 201 },
      );
    }

    return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Unsupported action.", requestId });
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
        message: "Invalid request payload.",
        details: error.issues,
        requestId,
      });
    }
    return internalErrorResponse("Workspace project operation failed.", requestId);
  }
  })(request);
}
