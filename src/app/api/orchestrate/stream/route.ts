import { NextRequest } from "next/server";
import { z } from "zod";
import { orchestrate, OrchestrationProgressEvent } from "@/lib/agents/orchestrator";

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

export async function POST(request: NextRequest) {
  let payload;
  try {
    const raw = await request.json();
    payload = bodySchema.parse(raw);
  } catch (err) {
    const message = err instanceof z.ZodError
      ? "Invalid request payload."
      : "Failed to parse request.";
    return new Response(message, { status: 400 });
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
        encode({ type: "error", message });
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
}
