import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ChatImageAttachment, runAgentLLM } from "@/lib/agents/llm";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { getSecretReadiness } from "@/lib/security/secrets";

const chatBodySchema = z.object({
  message: z.string(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(120).optional(),
        mimeType: z.string().regex(/^image\//),
        dataUrl: z.string().regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,/),
      }),
    )
    .max(3)
    .optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .max(20)
    .optional(),
}).superRefine((value, ctx) => {
  if (value.message.trim().length === 0 && (!value.attachments || value.attachments.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message or attachments are required.",
      path: ["message"],
    });
  }
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
- For execution requests (build/commit/push/deploy), do not stall on optional confirmations. Assume sensible defaults and proceed: current workspace, current git remote, default branch (main) unless the user specifies otherwise.
- Ask follow-up questions only when a required secret/credential/permission is missing or when an action is truly ambiguous and cannot proceed safely.
- When GitHub integration is available in the app, do not claim you categorically lack GitHub access. Explain that Cr8or Studio can access GitHub through its configured integration routes, while direct local workspace file access depends on runtime.
- If the user asks for links after deploy, include both local and live links when known (local usually http://localhost:3000; live from deployment output).
- Do not claim actions are completed unless completion is explicitly present in provided runtime context. For queued/delegated work, say "queued", "in progress", or "pending result" instead of reporting success.
- Never fabricate final commit SHAs, deployment success, or production URLs. If a URL is unknown, say it will be reported after execution output confirms it.
- Never output internal reasoning or meta commentary about instructions/policies/formatting. Do not output placeholders like <suggestion 1>.

Output format (strict):
Response:
<your conversational response>

Suggestions:
- <suggestion 1>
- <suggestion 2>
- <suggestion 3>
`.trim();

function buildCapabilityContext() {
  const readiness = getSecretReadiness();
  const localFilesAvailable = !process.env.VERCEL_ENV;

  return [
    "Runtime capabilities:",
    `- GitHub integration ready: ${readiness.checks.github ? "yes" : "no"}`,
    `- Vercel integration ready: ${readiness.checks.vercel ? "yes" : "no"}`,
    `- Local workspace file access available: ${localFilesAvailable ? "yes" : "no"}`,
    localFilesAvailable
      ? "- You may refer to local workspace editing as available in this runtime."
      : "- In deployed/runtime-hosted mode, local repository files are not directly readable; use GitHub integration for repository access.",
  ].join("\n");
}

function isDelegationIntent(message: string): boolean {
  const lower = message.toLowerCase();
  const executionTerms = [
    "build",
    "implement",
    "analyze",
    "analysis",
    "scan",
    "inspect",
    "review",
    "audit",
    "explore",
    "check",
    "look at",
    "summarize",
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

function stripDelegationClaims(reply: string): string {
  const lines = reply
    .split("\n")
    .filter((line) => {
      const normalized = line.toLowerCase();
      if (normalized.includes("queued") || normalized.includes("in progress") || normalized.includes("result pending")) {
        return false;
      }
      return true;
    });

  const cleaned = lines.join("\n").trim();
  return cleaned || "I can help with that. Share what you want me to analyze and I will proceed.";
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

  const cleanedResponse = sanitizeAgentText(response);
  const cleanedSuggestions = suggestions
    .map((item) => sanitizeAgentText(item))
    .filter((item) => item.length > 0)
    .filter((item) => !/^<.*>$/.test(item))
    .filter((item, index, arr) => arr.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, 5);

  return { response: cleanedResponse, suggestions: cleanedSuggestions };
}

function sanitizeAgentText(text: string): string {
  const blockedPatterns = [
    /^(we need|the user|let'?s craft|need to follow exact format|output format|rules:|suggestions?:|response:|but image|need conversational)\b/i,
    /^(also maybe|better to|we should|i should)\b/i,
    /^<.*>$/,
  ];

  const cleaned = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !blockedPatterns.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .trim();

  return cleaned || "I can help with that. The previous model output was malformed, so please retry and I will continue from there.";
}

function buildChatPrompt(
  history: Array<{ role: "user" | "assistant"; content: string }> | undefined,
  message: string,
  attachments: ChatImageAttachment[] = [],
): string {
  const transcript = (history ?? [])
    .slice(-12)
    .map((entry) => `${entry.role === "user" ? "User" : "Cr8or AI"}: ${entry.content}`)
    .join("\n");

  const attachmentSummary = attachments.length > 0
    ? `Attached images: ${attachments.map((attachment) => attachment.name || attachment.mimeType).join(", ")}`
    : "";

  return [
    "Conversation so far:",
    transcript || "(none)",
    "",
    `User: ${message}`,
    attachmentSummary,
    "Cr8or AI:",
  ].filter(Boolean).join("\n");
}

function buildDelegationAcknowledgement(message: string): { reply: string; suggestions: string[] } {
  return {
    reply: [
      "I am queuing this task for specialist agents now.",
      "",
      "Execution plan:",
      "1. Delegate the request to the orchestrator with current workspace defaults.",
      "2. Run the required analysis/build steps and capture concrete outputs.",
      "3. Report only verified results from runtime/tool output.",
      "",
      `Queued task: ${message}`,
      "Status: in progress, result pending.",
    ].join("\n"),
    suggestions: [
      "If you want extra depth, specify exactly which module/folder to prioritize.",
      "I can include a concise summary first, then a detailed technical breakdown.",
      "If this is urgent, ask for a quick pass first and a deep pass after.",
    ],
  };
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/chat/main", async (request: NextRequest, { requestId }) => {
  const auth = await authorizeRoute(request, { route: "api/chat/main", minRole: "viewer", requestId });
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const raw = await request.json();
    const payload = chatBodySchema.parse(raw);
    const shouldDelegate = isDelegationIntent(payload.message);

    if (shouldDelegate) {
      const ack = buildDelegationAcknowledgement(payload.message);
      return NextResponse.json(
        {
          reply: ack.reply,
          suggestions: ack.suggestions,
          shouldDelegate: true,
          delegatePrompt: payload.message,
        },
        { status: 200 },
      );
    }

    const prompt = buildChatPrompt(payload.history, payload.message, payload.attachments);
    const rawReply = await runAgentLLM(`${MAIN_AGENT_SYSTEM_PROMPT}\n\n${buildCapabilityContext()}`, prompt, undefined, payload.attachments ?? []);
    const parsed = parseReply(rawReply);
    const reply = stripDelegationClaims(parsed.response);

    return NextResponse.json(
      {
        reply,
        suggestions: parsed.suggestions,
        shouldDelegate: false,
        delegatePrompt: payload.message,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Invalid chat request payload.",
        details: error.issues,
        requestId,
      });
    }

    return internalErrorResponse("Failed to generate main agent reply.", requestId);
  }
  })(request);
}
