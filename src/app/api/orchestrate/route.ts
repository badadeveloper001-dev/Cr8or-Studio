import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { orchestrate } from "@/lib/agents/orchestrator";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  prompt: z.string().min(5),
  projectId: z.string().min(2),
  context: z
    .object({
      openFiles: z.array(z.string()).optional(),
      repository: z.string().optional(),
      branch: z.string().optional(),
    })
    .optional(),
});

async function POSTHandler(request: NextRequest) {
  return withRouteMetrics("api/orchestrate", async (request: NextRequest, { requestId }) => {
  const auth = await authorizeRoute(request, { route: "api/orchestrate", minRole: "viewer", requestId });
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const raw = await request.json();
    const payload = bodySchema.parse(raw);
    const result = await orchestrate(payload);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Invalid orchestration request payload.",
        details: error.issues,
        requestId,
      });
    }

    return internalErrorResponse("Failed to orchestrate multi-agent execution.", requestId);
  }
  })(request);
}

export const POST = withPrivateApiAuth(
  { route: "api/orchestrate:post", minRole: "viewer", privateExecutionBlocked: true },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/orchestrate:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST" } }),
);
