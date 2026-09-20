import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { prisma } from "@/lib/db/prisma";
import { CLOUD_REPOSITORY_ROOT } from "@/lib/workspace/cloud-path";

const previewBodySchema = z.object({
  action: z.enum(["start", "refresh", "stop"]),
});

const PREVIEW_PORT = 3000;
const PREVIEW_TTL_SECONDS = 3600;
const PREVIEW_SESSION_ID = "cr8or-preview";
const READINESS_POLL_INTERVAL_MS = 1500;
const READINESS_MAX_ATTEMPTS = 12;

async function resolveDaytonaSandbox(projectId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { projectId },
  });

  if (!workspace || workspace.runtimeType !== "cloud" || !workspace.providerWorkspaceId) {
    return null;
  }

  const apiKey = process.env.DAYTONA_API_KEY;
  const apiUrl = process.env.DAYTONA_API_URL;
  if (!apiKey) {
    return null;
  }

  const { DaytonaProvider } = await import("@/lib/workspace/providers/daytona");
  const provider = new DaytonaProvider({ apiKey, apiUrl });
  const sandbox = await provider.getSandbox(workspace.providerWorkspaceId);
  return sandbox;
}

async function isDevServerRunning(sandbox: Awaited<ReturnType<typeof resolveDaytonaSandbox>>): Promise<boolean> {
  if (!sandbox) return false;
  try {
    const proc = sandbox.process;
    const result = await proc.executeCommand(
      "pgrep -f 'next dev' > /dev/null 2>&1 && echo RUNNING || echo STOPPED",
      CLOUD_REPOSITORY_ROOT,
    );
    const output = (result.artifacts?.stdout ?? result.result ?? "").trim();
    return output.includes("RUNNING");
  } catch {
    return false;
  }
}

async function getDevScript(sandbox: Awaited<ReturnType<typeof resolveDaytonaSandbox>>): Promise<string> {
  if (!sandbox) return "npm run dev";
  try {
    const fs = sandbox.fs;
    const pkgPath = `${CLOUD_REPOSITORY_ROOT}/package.json`;
    const buffer = await fs.downloadFile(pkgPath);
    const pkg = JSON.parse(buffer.toString("utf8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.dev) return "npm run dev";
    if (pkg.scripts?.start) return "npm start";
    return "npm run dev";
  } catch {
    return "npm run dev";
  }
}

async function waitForDevServer(sandbox: Awaited<ReturnType<typeof resolveDaytonaSandbox>>): Promise<{ ready: boolean; error?: string }> {
  if (!sandbox) return { ready: false, error: "Sandbox unavailable" };
  const proc = sandbox.process;

  for (let attempt = 0; attempt < READINESS_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
    try {
      const check = await proc.executeCommand(
        `curl -s -o /dev/null -w "%{http_code}" http://localhost:${PREVIEW_PORT}/ || echo "000"`,
        CLOUD_REPOSITORY_ROOT,
      );
      const status = (check.artifacts?.stdout ?? check.result ?? "").trim();
      if (status === "200" || status === "301" || status === "302") {
        return { ready: true };
      }
    } catch {
      // Server not yet responding, continue polling
    }
  }

  const stillRunning = await isDevServerRunning(sandbox);
  if (!stillRunning) {
    return { ready: false, error: "Dev server process exited before becoming ready" };
  }

  return { ready: false, error: "Dev server did not respond within expected time" };
}

async function stopPreviewProcesses(sandbox: Awaited<ReturnType<typeof resolveDaytonaSandbox>>): Promise<void> {
  if (!sandbox) return;
  const proc = sandbox.process;
  try {
    await proc.executeCommand(
      "pkill -f 'next dev' || true",
      CLOUD_REPOSITORY_ROOT,
    );
    await proc.executeCommand(
      "pkill -f 'next-server' || true",
      CLOUD_REPOSITORY_ROOT,
    );
  } catch {
    // Best-effort kill
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  return withRouteMetrics("api/workspaces/preview", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, { route: "api/workspaces:preview", minRole: "viewer", requestId });
    if (!auth.ok) return auth.response;

    try {
      const { projectId } = await params;
      const raw = await request.json();
      const payload = previewBodySchema.parse(raw);

      const sandbox = await resolveDaytonaSandbox(projectId);
      if (!sandbox) {
        return errorResponse({
          status: 404,
          code: "NOT_FOUND",
          message: "Cloud workspace not found or preview not available.",
          requestId,
        });
      }

      if (payload.action === "start" || payload.action === "refresh") {
        const alreadyRunning = await isDevServerRunning(sandbox);

        if (!alreadyRunning) {
          await stopPreviewProcesses(sandbox);

          const devScript = await getDevScript(sandbox);
          const proc = sandbox.process;

          try {
            await proc.createSession(PREVIEW_SESSION_ID);
          } catch {
            // Session may already exist, try to delete and recreate
            try {
              await proc.deleteSession(PREVIEW_SESSION_ID);
              await proc.createSession(PREVIEW_SESSION_ID);
            } catch {
              // If session creation still fails, fall back to executeCommand with timeout
              await proc.executeCommand(
                `${devScript} -- --port ${PREVIEW_PORT} --hostname 0.0.0.0 &`,
                CLOUD_REPOSITORY_ROOT,
              );
            }
          }

          try {
            await proc.executeSessionCommand(PREVIEW_SESSION_ID, {
              command: `${devScript} -- --port ${PREVIEW_PORT} --hostname 0.0.0.0`,
              runAsync: true,
            });
          } catch {
            // If session command fails, try direct background execution
            await proc.executeCommand(
              `nohup ${devScript} -- --port ${PREVIEW_PORT} --hostname 0.0.0.0 > /tmp/preview.log 2>&1 &`,
              CLOUD_REPOSITORY_ROOT,
            );
          }

          const { ready, error } = await waitForDevServer(sandbox);
          if (!ready) {
            return errorResponse({
              status: 502,
              code: "UPSTREAM_ERROR",
              message: error || "Dev server failed to start.",
              requestId,
            });
          }
        }

        const signedUrl = await sandbox.getSignedPreviewUrl(PREVIEW_PORT, PREVIEW_TTL_SECONDS);
        const expiresAt = new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString();

        return NextResponse.json({
          ok: true,
          url: signedUrl.url,
          port: PREVIEW_PORT,
          expiresAt,
          status: "running",
        });
      }

      if (payload.action === "stop") {
        await stopPreviewProcesses(sandbox);
        try {
          const proc = sandbox.process;
          await proc.deleteSession(PREVIEW_SESSION_ID);
        } catch {
          // Best-effort cleanup
        }
        return NextResponse.json({ ok: true, status: "stopped" });
      }

      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Invalid preview action.",
        requestId,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Invalid preview request payload.",
          details: error.issues,
          requestId,
        });
      }
      return internalErrorResponse("Failed to process preview request.", requestId);
    }
  })(request);
}
