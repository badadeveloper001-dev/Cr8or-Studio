import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { createDaytonaProvider, validateDaytonaConfig } from "@/lib/workspace/providers/daytona";
import { CloudWorkspaceRuntime } from "@/lib/workspace/runtime-cloud";
import { setProjectToCloud } from "@/lib/workspace/runtime-factory";

const bodySchema = z.object({
  repositoryUrl: z.string().url().min(8).max(2048),
  branch: z.string().optional(),
  projectName: z.string().trim().min(1).max(120).optional(),
});

function isValidGitHubUrl(url: string): boolean {
  const httpsForm = url.startsWith("https://github.com/");
  if (!httpsForm) {
    return false;
  }
  if (/[\s"';`$&|<>\\]|\.\.|--/.test(url)) {
    return false;
  }
  if (url.includes("@")) {
    return false;
  }
  return true;
}

function extractRepoInfo(url: string): { owner: string; repo: string; branch?: string } | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) {
      return null;
    }
    const owner = pathParts[0];
    const repo = pathParts[1].replace(/\.git$/, "");
    const branch = urlObj.searchParams.get("branch") || undefined;
    return { owner, repo, branch };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/workspaces", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, { route: "api/workspaces", minRole: "maintainer", requestId });
    if (!auth.ok) {
      return auth.response;
    }

    try {
      const raw = await request.json();
      const body = bodySchema.parse(raw);

      // Validate Daytona configuration
      const daytonaConfig = {
        apiKey: process.env.DAYTONA_API_KEY,
        apiUrl: process.env.DAYTONA_API_URL,
      };
      const configValidation = validateDaytonaConfig(daytonaConfig);
      if (!configValidation.ok) {
        return errorResponse({
          status: 409,
          code: "CONFLICT",
          message: `Daytona configuration error: ${configValidation.error}`,
          requestId,
        });
      }

      // Validate repository URL
      if (!isValidGitHubUrl(body.repositoryUrl)) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Invalid GitHub repository URL. Use https://github.com/owner/repo format.",
          requestId,
        });
      }

      const repoInfo = extractRepoInfo(body.repositoryUrl);
      if (!repoInfo) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Could not extract repository information from URL.",
          requestId,
        });
      }

      // Check policy for project creation
      const preview = {
        action: "workspace.create",
        repositoryUrl: body.repositoryUrl,
        branch: body.branch,
      };
      const policy = evaluatePolicyGuard({
        action: "project.create",
        requestId,
        actorId: auth.session.userId,
        actorRole: auth.session.role,
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

      // Create Daytona provider
      const provider = createDaytonaProvider({
        apiKey: process.env.DAYTONA_API_KEY!,
        apiUrl: process.env.DAYTONA_API_URL,
      });

      // Generate project name from repository
      const projectName = body.projectName || repoInfo.repo;
      const projectId = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 64);

      // Create Daytona sandbox
      let sandbox;
      try {
        sandbox = await provider.createSandbox({
          id: projectId,
          name: projectName,
          gitProvider: "github",
          gitRepo: body.repositoryUrl,
          gitBranch: body.branch || "main",
          envVars: {
            GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
          },
        });
      } catch (error) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: `Failed to create sandbox: ${error instanceof Error ? error.message : "Unknown error"}`,
          requestId,
        });
      }

      // Wait for sandbox to be ready
      await sandbox.waitUntilStarted();

      // Clone repository
      try {
        const git = sandbox.git;
        await git.clone(body.repositoryUrl, {
          branch: body.branch || "main",
        });
      } catch (error) {
        // Clean up sandbox on clone failure
        await sandbox.delete();
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: `Failed to clone repository: ${error instanceof Error ? error.message : "Unknown error"}`,
          requestId,
        });
      }

      // Set project to cloud mode
      setProjectToCloud(projectId, "daytona", sandbox.id, body.repositoryUrl, body.branch);

      // Return workspace info
      const runtime = new CloudWorkspaceRuntime({
        id: `cloud-${projectId}`,
        projectId,
        provider: "daytona",
        providerWorkspaceId: sandbox.id,
        repositoryUrl: body.repositoryUrl,
        branch: body.branch,
        createdAt: new Date(),
      });

      await runtime.initialize();

      return NextResponse.json(
        {
          ok: true,
          workspace: {
            id: sandbox.id,
            projectId,
            provider: "daytona",
            repositoryUrl: body.repositoryUrl,
            branch: body.branch || "main",
            state: "ready",
            createdAt: new Date().toISOString(),
          },
        },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Invalid request payload.",
          details: error.issues,
          requestId,
        });
      }
      return internalErrorResponse("Failed to create workspace.", requestId);
    }
  })(request);
}