import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { orchestrate } from "@/lib/agents/orchestrator";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { authError } from "@/lib/security/private-auth-http";
import {
  cancelExecutionAuthorization,
  createExecutionAuthorization,
  ExecutionAuthorizationError,
  revalidateExecutionAuthorization,
  type ExecutionAuthorizationContext,
} from "@/lib/security/execution-context";

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

  let authorization: ExecutionAuthorizationContext | undefined;
  try {
    const raw = await request.json();
    const payload = bodySchema.parse(raw);
    authorization = await createExecutionAuthorization(auth.session, payload.projectId, { signal: request.signal });
    const result = await orchestrate(payload, undefined, authorization);
    await revalidateExecutionAuthorization(authorization, payload.projectId, "model");
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) {
      if (error.status === 401 || error.status === 503) return authError(error.status, error.message);
      return errorResponse({
        status: error.status,
        code: error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "FORBIDDEN",
        message: error.message,
        requestId,
      });
    }
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
  } finally {
    cancelExecutionAuthorization(authorization);
  }
  })(request);
}

export const POST = withPrivateApiAuth(
  { route: "api/orchestrate:post", minRole: "viewer" },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/orchestrate:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST" } }),
);
