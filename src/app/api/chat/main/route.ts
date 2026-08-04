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
- Be conversational, clear, and practical.
- If a request is execution-oriented, provide a short delegation plan.
- If a request is exploratory, answer naturally and offer good next options.
- Ground your advice in architecture, product impact, quality, and risk.
- If you are uncertain, state assumptions briefly.

Output format (strict):
Response:
<your conversational response>

Suggestions:
- <suggestion 1>
- <suggestion 2>
- <suggestion 3>
`.trim();

function isDelegationIntent(message: string): boolean {
  const lower = message.toLowerCase();
  const executionTerms = [
    "build",
    "implement",
    "create",
    "fix",
    "run",
    "deploy",
    "refactor",
    "generate",
    "add",
    "update",
    "ship",
    "set up",
    "setup",
    "wire",
    "make",
  ];
  const exploratoryStarts = ["what", "why", "how", "can you explain", "should we", "which"];
  const asksQuestion = lower.includes("?") || exploratoryStarts.some((start) => lower.startsWith(start));
  const hasExecution = executionTerms.some((term) => lower.includes(term));
  if (asksQuestion && !hasExecution) return false;
  return hasExecution;
}

function parseReply(raw: string): { response: string; suggestions: string[] } {
  const lines = raw.split("\n");
  const suggestionsIndex = lines.findIndex((line) => /^\s*suggestions\s*:/i.test(line));

  const responseLines = (suggestionsIndex >= 0 ? lines.slice(0, suggestionsIndex) : lines)
    .filter((line) => !/^\s*response\s*:/i.test(line));

  const suggestions =
    suggestionsIndex >= 0
      ? lines
          .slice(suggestionsIndex + 1)
          .map((line) => line.trim())
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2).trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

  const response = responseLines.join("\n").trim() || raw.trim();
  return { response, suggestions };
}

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
    const rawReply = await runAgentLLM(MAIN_AGENT_SYSTEM_PROMPT, prompt);
    const parsed = parseReply(rawReply);
    const shouldDelegate = isDelegationIntent(payload.message);

    return NextResponse.json(
      {
        reply: parsed.response,
        suggestions: parsed.suggestions,
        shouldDelegate,
        delegatePrompt: payload.message,
      },
      { status: 200 },
    );
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
