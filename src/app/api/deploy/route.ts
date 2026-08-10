import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { runSandboxedCommand, SandboxViolationError } from "@/lib/security/sandbox";
import { getSecret } from "@/lib/security/secrets";
import { resolveWorkspacePath, sanitizeWorkspacePath, WORKSPACE_ROOT } from "@/lib/workspace/shell";

const bodySchema = z.object({
  projectPath: z.string().default("."),
  strategy: z.enum(["build-only", "vercel"]).default("build-only"),
  dryRun: z.boolean().optional(),
  approvalId: z.string().uuid().optional(),
});

function resolveCwd(projectPath: string): string | null {
  if (projectPath === ".") {
    return WORKSPACE_ROOT;
  }

  const safe = sanitizeWorkspacePath(projectPath);
  if (!safe) {
    return null;
  }

  return resolveWorkspacePath(safe);
}

function extractVercelUrls(output: string): {
  productionUrl?: string;
  aliasUrl?: string;
  inspectUrl?: string;
} {
  const productionMatches = Array.from(output.matchAll(/Production\s+(https:\/\/[^\s]+)/g));
  const inspectMatch = output.match(/Inspect\s+(https:\/\/[^\s]+)/);
  const aliasMatch = output.match(/Aliased\s+(https:\/\/[^\s]+)/);

  const productionUrl = productionMatches.length > 0
    ? productionMatches[productionMatches.length - 1]?.[1]
    : undefined;

  return {
    productionUrl,
    aliasUrl: aliasMatch?.[1],
    inspectUrl: inspectMatch?.[1],
  };
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/deploy", async (request: NextRequest, { requestId }) => {
  const auth = await authorizeRoute(request, {
    route: "api/deploy",
    minRole: "owner",
    requestId,
    requireWorkspaceOwnership: true,
  });
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const raw = await request.json();
    const payload = bodySchema.parse(raw);

    const cwd = resolveCwd(payload.projectPath);
    if (!cwd) {
      return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid project path.", requestId });
    }

    const deployPreview = {
      action: "deploy.vercel",
      cwd,
      strategy: payload.strategy,
      commands:
        payload.strategy === "vercel"
          ? ["npm run build", "npx vercel --prod --yes"]
          : ["npm run build"],
    };

    if (payload.dryRun) {
      return NextResponse.json({ dryRun: true, preview: deployPreview }, { status: 200 });
    }

    if (payload.strategy === "vercel") {
      const policy = evaluatePolicyGuard({
        action: "deploy.vercel",
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
              action: "deploy.vercel",
            },
            preview: deployPreview,
          },
          { status: 409 },
        );
      }
    }

    const logs: string[] = [];
    const build = await runSandboxedCommand({
      command: "npm run build",
      cwd,
      workspaceId: payload.projectPath,
      route: "api/deploy:build",
      actorId: auth.session.userId,
      actorRole: auth.session.role,
      requestId,
      allowedRoots: [cwd],
      allowedCommands: [{ kind: "exact", value: "npm run build" }],
    });
    logs.push("Build complete.");
    if (build.stdout) logs.push(build.stdout);
    if (build.stderr) logs.push(build.stderr);

    if (payload.strategy === "vercel") {
      const token = getSecret("VERCEL_TOKEN", requestId);
      if (!token) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Missing VERCEL_TOKEN for deployment.",
          requestId,
        });
      }

      const deploy = await runSandboxedCommand({
        command: "npx vercel --prod --yes",
        cwd,
        workspaceId: payload.projectPath,
        route: "api/deploy:vercel",
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        requestId,
        allowedRoots: [cwd],
        allowedCommands: [{ kind: "exact", value: "npx vercel --prod --yes" }],
        envOverrides: { VERCEL_TOKEN: token },
        redactValues: [token],
      });
      logs.push("Vercel deploy complete.");
      if (deploy.stdout) logs.push(deploy.stdout);
      if (deploy.stderr) logs.push(deploy.stderr);

      const combinedOutput = [deploy.stdout, deploy.stderr].filter(Boolean).join("\n");
      const urls = extractVercelUrls(combinedOutput);

      return NextResponse.json(
        {
          success: true,
          logs: logs.join("\n"),
          receipt: {
            strategy: payload.strategy,
            ...urls,
          },
        },
        { status: 200 },
      );
    }

    return NextResponse.json({
      success: true,
      logs: logs.join("\n"),
      receipt: {
        strategy: payload.strategy,
      },
    }, { status: 200 });
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
        message: "Invalid deploy request.",
        details: error.issues,
        requestId,
      });
    }
    return internalErrorResponse("Deploy operation failed.", requestId);
  }
  })(request);
}
