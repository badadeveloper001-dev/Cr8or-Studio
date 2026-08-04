import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { orchestrate } from "@/lib/agents/orchestrator";

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

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    const payload = bodySchema.parse(raw);
    const result = await orchestrate(payload);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          message: "Invalid orchestration request payload.",
          issues: error.issues,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        message: "Failed to orchestrate multi-agent execution.",
      },
      { status: 500 },
    );
  }
}
