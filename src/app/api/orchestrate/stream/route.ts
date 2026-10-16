import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest } from "next/server";
import { z } from "zod";
import { orchestrate, OrchestrationProgressEvent } from "@/lib/agents/orchestrator";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { redactText } from "@/lib/security/redaction";

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

  const stream = new ReadableStream({
    async start(controller) {
      const encode = (event: OrchestrationProgressEvent) => {
        controller.enqueue(new TextEncoder().encode(encodeEvent(event)));
      };

      try {
        await orchestrate(payload, encode);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Orchestration failed.";
        encode({ type: "error", message: redactText(message) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
  })(request);
}

export const POST = withPrivateApiAuth(
  { route: "api/orchestrate/stream:post", minRole: "viewer", privateExecutionBlocked: true },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/orchestrate/stream:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST" } }),
);
