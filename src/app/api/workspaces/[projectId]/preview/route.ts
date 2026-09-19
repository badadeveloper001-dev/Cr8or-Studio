import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { prisma } from "@/lib/db/prisma";

const previewBodySchema = z.object({
  action: z.enum(["start", "refresh", "stop"]),
});

const PREVIEW_PORT = 3000;
const PREVIEW_TTL_SECONDS = 3600;

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  return withRouteMetrics("api/workspaces/preview", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, { route: "api/workspaces/preview", minRole: "viewer", requestId });
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
        if (payload.action === "start") {
          const proc = sandbox.process;
          await proc.executeCommand(
            "npm run dev -- --port 3000 --hostname 0.0.0.0",
            "/workspace/repo",
          );
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
        const proc = sandbox.process;
        await proc.executeCommand(
          "pkill -f 'next dev' || true",
          "/workspace/repo",
        );
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
