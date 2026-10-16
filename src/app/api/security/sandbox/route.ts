import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { cancelSandboxOperation, getSandboxRuntimeSnapshot } from "@/lib/security/sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  intent: z.literal("cancel"),
  operationId: z.string().uuid(),
});

async function GETHandler(request: NextRequest) {
  return withRouteMetrics("api/security/sandbox:get", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, {
      route: "api/security/sandbox:get",
      minRole: "owner",
      requestId,
      requireWorkspaceOwnership: true,
    });
    if (!auth.ok) return auth.response;

    return NextResponse.json(
      {
        ok: true,
        runtime: getSandboxRuntimeSnapshot(),
      },
      { status: 200 },
    );
  })(request);
}

async function POSTHandler(request: NextRequest) {
  return withRouteMetrics("api/security/sandbox:post", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, {
      route: "api/security/sandbox:post",
      minRole: "owner",
      requestId,
      requireWorkspaceOwnership: true,
    });
    if (!auth.ok) return auth.response;

    try {
      const raw = await request.json();
      const payload = bodySchema.parse(raw);
      const cancelled = cancelSandboxOperation(payload.operationId, auth.session.userId, auth.session.role);

      return NextResponse.json(
        {
          ok: true,
          cancelled,
        },
        { status: cancelled ? 200 : 404 },
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Invalid sandbox request payload.",
          details: error.issues,
          requestId,
        });
      }

      return internalErrorResponse("Sandbox operation failed.", requestId);
    }
  })(request);
}

export const GET = withPrivateApiAuth(
  { route: "api/security/sandbox:get", minRole: "viewer" },
  GETHandler,
);

export const POST = withPrivateApiAuth(
  { route: "api/security/sandbox:post", minRole: "viewer" },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/security/sandbox:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS, POST" } }),
);
