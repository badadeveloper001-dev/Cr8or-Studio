import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { CLOUD_REPOSITORY_ROOT, shellQuote } from "@/lib/workspace/cloud-path";
import { findCloudProject } from "@/lib/workspace/cloud-projects";

export const maxDuration = 300;

const previewBodySchema = z.object({
  action: z.enum(["start", "refresh", "stop"]),
});

const PREVIEW_PORT = 3000;
const PREVIEW_TTL_SECONDS = 3600;
const PREVIEW_SESSION_ID = "cr8or-preview";
const READINESS_POLL_INTERVAL_MS = 1500;
const READINESS_MAX_ATTEMPTS = 30;
class PreviewSetupError extends Error {}

async function resolveDaytonaSandbox(projectId: string, userId: string, role: string) {
  const workspace = await findCloudProject(projectId, userId, role);

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
  if (sandbox?.state === "stopped") await sandbox.start(60);
  if (sandbox && sandbox.state !== "started") await sandbox.waitUntilStarted();
  return sandbox;
}

async function isDevServerRunning(sandbox: Awaited<ReturnType<typeof resolveDaytonaSandbox>>): Promise<boolean> {
  if (!sandbox) return false;
  try {
    const proc = sandbox.process;
    const result = await proc.executeCommand(
      "pgrep -f '[n]ext dev|[n]ext-server|[v]ite' > /dev/null 2>&1 && echo RUNNING || echo STOPPED",
      CLOUD_REPOSITORY_ROOT,
    );
    const output = (result.artifacts?.stdout ?? result.result ?? "").trim();
    return output.includes("RUNNING");
  } catch {
    return false;
  }
}

async function getDevScript(sandbox: Awaited<ReturnType<typeof resolveDaytonaSandbox>>): Promise<string> {
  if (!sandbox) throw new PreviewSetupError("The cloud workspace is unavailable.");
  try {
    const fs = sandbox.fs;
    const pkgPath = `${CLOUD_REPOSITORY_ROOT}/package.json`;
    const buffer = await fs.downloadFile(pkgPath);
    const pkg = JSON.parse(buffer.toString("utf8")) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.dev || pkg.scripts?.start;
    if (!script) throw new PreviewSetupError("Add a dev or start script to package.json before starting preview.");
    const command = pkg.scripts?.dev ? "npm run dev" : "npm start";
    const flags = /\bnext\b/.test(script) ? ` -- --port ${PREVIEW_PORT} --hostname 0.0.0.0`
      : /\bvite\b/.test(script) ? ` -- --port ${PREVIEW_PORT} --host 0.0.0.0` : "";
    return `PORT=${PREVIEW_PORT} HOST=0.0.0.0 ${command}${flags}`;
  } catch (error) {
    if (error instanceof PreviewSetupError) throw error;
    throw new PreviewSetupError("Preview needs a readable package.json in the project root.");
  }
}

async function waitForDevServer(sandbox: Awaited<ReturnType<typeof resolveDaytonaSandbox>>): Promise<{ ready: boolean; error?: string }> {
  if (!sandbox) return { ready: false, error: "Sandbox unavailable" };
  const proc = sandbox.process;

  for (let attempt = 0; attempt < READINESS_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
    try {
      const check = await proc.executeCommand(
        `curl -s --max-time 3 -o /dev/null -w "%{http_code}" http://localhost:${PREVIEW_PORT}/`,
        CLOUD_REPOSITORY_ROOT,
      );
      const status = (check.artifacts?.stdout ?? check.result ?? "").trim();
      if (/^[23]\d\d$/.test(status)) {
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
      "pkill -f '[n]ext dev' || true",
      CLOUD_REPOSITORY_ROOT,
    );
    await proc.executeCommand(
      "pkill -f '[n]ext-server|[v]ite' || true",
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
    const auth = await authorizeRoute(request, { route: "api/workspaces:preview", minRole: "maintainer", requestId });
    if (!auth.ok) return auth.response;

    try {
      const { projectId } = await params;
      const raw = await request.json();
      const payload = previewBodySchema.parse(raw);

      const sandbox = await resolveDaytonaSandbox(projectId, auth.session.userId, auth.session.role);
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

          const install = "if [ ! -d node_modules ]; then if [ -f package-lock.json ]; then npm ci --include=dev; else npm install --include=dev; fi; fi";
          const command = `cd ${shellQuote(CLOUD_REPOSITORY_ROOT)} && (${install}) && ${devScript}`;
          try {
            try {
              await proc.createSession(PREVIEW_SESSION_ID);
            } catch {
              await proc.deleteSession(PREVIEW_SESSION_ID);
              await proc.createSession(PREVIEW_SESSION_ID);
            }
            await proc.executeSessionCommand(PREVIEW_SESSION_ID, {
              command,
              runAsync: true,
            });
          } catch {
            // If session command fails, try direct background execution
            await proc.executeCommand(
              `nohup sh -c ${shellQuote(`(${install}) && ${devScript}`)} > /tmp/preview.log 2>&1 &`,
              CLOUD_REPOSITORY_ROOT,
            );
          }
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
        const signedUrl = await sandbox.getSignedPreviewUrl(PREVIEW_PORT, PREVIEW_TTL_SECONDS);
        // A listening process alone does not prove that the browser can reach it.
        const preview = await fetch(signedUrl.url, { signal: AbortSignal.timeout(15000) });
        await preview.body?.cancel();
        if (!preview.ok) {
          return errorResponse({ status: 502, code: "UPSTREAM_ERROR", message: "The dev server started, but the preview URL is not responding successfully. Try refreshing preview.", requestId });
        }
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
      if (error instanceof PreviewSetupError) {
        return errorResponse({ status: 502, code: "UPSTREAM_ERROR", message: error.message, requestId });
      }
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
