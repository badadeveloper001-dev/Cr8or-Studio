import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { runAgentLLM } from "@/lib/agents/llm";

const chatBodySchema = z.object({
  message: z.string().min(1),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .max(20)
    .optional(),
});

const MAIN_AGENT_SYSTEM_PROMPT = `
You are Cr8or AI, the Software Engineering Lead in Cr8or Studio.
You delegate delivery work to specialist agents and keep execution aligned to product goals.

Rules:
- Be practical, concise, and implementation-focused.
- Assume requests are actionable and frame your reply as the delegation plan.
- Ground your advice in architecture, product impact, quality, and risk.
- If you are uncertain, state assumptions briefly.
`.trim();

function buildChatPrompt(history: Array<{ role: "user" | "assistant"; content: string }> | undefined, message: string): string {
  const transcript = (history ?? [])
    .slice(-12)
    .map((entry) => `${entry.role === "user" ? "User" : "Cr8or AI"}: ${entry.content}`)
    .join("\n");

  return [
    "Conversation so far:",
    transcript || "(none)",
    "",
    `User: ${message}`,
    "Cr8or AI:",
  ].join("\n");
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    const payload = chatBodySchema.parse(raw);

    const prompt = buildChatPrompt(payload.history, payload.message);
    const reply = await runAgentLLM(MAIN_AGENT_SYSTEM_PROMPT, prompt);

    return NextResponse.json({ reply }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          message: "Invalid chat request payload.",
          issues: error.issues,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        message: "Failed to generate main agent reply.",
      },
      { status: 500 },
    );
  }
}
