import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest } from "next/server";
import { z } from "zod";
import { orchestrate, OrchestrationProgressEvent } from "@/lib/agents/orchestrator";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { authError } from "@/lib/security/private-auth-http";
import { redactText } from "@/lib/security/redaction";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import {
  cancelExecutionAuthorization,
  createExecutionAuthorization,
  ExecutionAuthorizationError,
  revalidateExecutionAuthorization,
  type ExecutionAuthorizationContext,
} from "@/lib/security/execution-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const maxDuration = 300;

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

function encodeEvent(event: OrchestrationProgressEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function POSTHandler(request: NextRequest) {
  return withRouteMetrics("api/orchestrate/stream", async (request: NextRequest) => {
  const auth = await authorizeRoute(request, { route: "api/orchestrate/stream", minRole: "viewer" });
  if (!auth.ok) {
    return auth.response;
  }

  let payload;
  try {
    const raw = await request.json();
    payload = bodySchema.parse(raw);
  } catch (err) {
    const message = err instanceof z.ZodError ? "Invalid request payload." : "Failed to parse request.";
    return new Response(
      JSON.stringify({ ok: false, message, error: { code: "INVALID_REQUEST", message } }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const cancellation = new AbortController();
  let authorization: ExecutionAuthorizationContext | undefined;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    cancellation.abort();
    cancelExecutionAuthorization(authorization);
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();

  try {
    // Resolve the canonical project before opening the stream or starting work.
    authorization = await createExecutionAuthorization(auth.session, payload.projectId, { signal: cancellation.signal });
    await revalidateExecutionAuthorization(authorization, payload.projectId, "model");
  } catch (error) {
    request.signal.removeEventListener("abort", cancel);
    cancel();
    if (error instanceof ExecutionAuthorizationError) {
      if (error.status === 401 || error.status === 503) return authError(error.status, error.message);
      return errorResponse({
        status: error.status,
        code: error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "FORBIDDEN",
        message: error.message,
      });
    }
    return internalErrorResponse("Failed to start execution.");
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encode = async (event: OrchestrationProgressEvent) => {
        await revalidateExecutionAuthorization(authorization, payload.projectId, "model");
        if (cancelled) throw new Error("Execution cancelled.");
        controller.enqueue(new TextEncoder().encode(encodeEvent(event)));
      };

      try {
        await orchestrate(payload, encode, authorization);
      } catch (err) {
        // A terminal error contains no model output or workspace data. Never
        // emit queued progress after the initiating session becomes invalid.
        if (!cancelled) {
          const message = err instanceof ExecutionAuthorizationError ? err.message
            : authorization ? "Execution could not be completed."
              : redactText(err instanceof Error ? err.message : "Orchestration failed.");
          controller.enqueue(new TextEncoder().encode(encodeEvent({ type: "error", message })));
        }
      } finally {
        request.signal.removeEventListener("abort", cancel);
        cancelExecutionAuthorization(authorization);
        if (!cancelled) controller.close();
      }
    },
    cancel,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
  })(request);
}

export const POST = withPrivateApiAuth(
  { route: "api/orchestrate/stream:post", minRole: "viewer" },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/orchestrate/stream:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST" } }),
);
