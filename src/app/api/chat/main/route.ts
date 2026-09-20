import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ChatImageAttachment, runAgentLLM } from "@/lib/agents/llm";
import { runAgentWithTools, getDefaultToolPreset } from "@/lib/agents/tool-loop";
import { ToolContext } from "@/lib/agents/tools";
import { AgentTask } from "@/lib/agents/types";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { getSecretReadiness } from "@/lib/security/secrets";
import { classifyIntent } from "@/lib/intent";
import { getWorkspaceConfig, getWorkspaceRuntime } from "@/lib/workspace/runtime-factory";
import { detectWorkspaceRequest } from "@/lib/workspace/workspace-request-detector";
import { performReadOnlyTaskLoop, performLocalReadinessCheck } from "@/lib/workspace/workspace-inspection";

const chatBodySchema = z.object({
  message: z.string(),
  projectId: z.string().optional(),
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

async function buildCapabilityContext(projectId?: string) {
  const readiness = getSecretReadiness();

  let workspaceLine: string;
  if (projectId) {
    try {
      const config = await getWorkspaceConfig(projectId);
      if (config.type === "cloud") {
        workspaceLine = "- Workspace file access: available (cloud runtime). Repository files can be read with workspace tools. GitHub integration is secondary for files already cloned.";
      } else {
        workspaceLine = "- Workspace file access: available (local runtime). Repository files can be read and edited directly.";
      }
    } catch {
      workspaceLine = "- Workspace file access: unavailable (workspace lookup failed). Use GitHub integration for repository access.";
    }
  } else {
    workspaceLine = "- Workspace file access: no project selected. Select a project to enable workspace file tools, or use GitHub integration for repository access.";
  }

  return [
    "Runtime capabilities:",
    `- GitHub integration ready: ${readiness.checks.github ? "yes" : "no"}`,
    `- Vercel integration ready: ${readiness.checks.vercel ? "yes" : "no"}`,
    workspaceLine,
  ].join("\n");
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

async function handleDirectWorkspaceRequest(
  projectId: string,
  message: string,
): Promise<{ reply: string; suggestions: string[] } | null> {
  const request = detectWorkspaceRequest(message);
  if (!request.type) return null;

  let runtime;
  try {
    runtime = await getWorkspaceRuntime(projectId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Workspace unavailable";
    return {
      reply: `The selected workspace could not be opened: ${reason}`,
      suggestions: ["Select a different project", "Check workspace status in the activity panel"],
    };
  }

  try {
    switch (request.type) {
      case "read_file": {
        if (!request.path) {
          return {
            reply: "Please specify which file to read. For example: \"Read package.json\" or \"Read src/app/page.tsx\".",
            suggestions: ["Read package.json", "List the files in the project root"],
          };
        }
        if (request.path === "package.json") {
          const result = await runtime.readFile("package.json");
          try {
            const pkg = JSON.parse(result.content);
            const name = pkg.name;
            const version = pkg.version;
            if (name) {
              const detail = version ? ` (version ${version})` : "";
              return {
                reply: `The project name is \`${name}\`${detail}.`,
                suggestions: ["List the files in the project root", "Show me git status"],
              };
            }
            return {
              reply: "`package.json` was read successfully, but it has no `name` field.",
              suggestions: ["List the files in the project root", "Show me git status"],
            };
          } catch {
            return {
              reply: "`package.json` was read but could not be parsed as JSON.",
              suggestions: ["List the files in the project root"],
            };
          }
        }
        const result = await runtime.readFile(request.path);
        const preview = result.content.length > 3000
          ? result.content.slice(0, 3000) + "\n\n... (truncated)"
          : result.content;
        return {
          reply: `Contents of \`${request.path}\`:\n\n\`\`\`\n${preview}\n\`\`\``,
          suggestions: ["List the files in the project root", "Show me git status"],
        };
      }
      case "list_files": {
        const files = await runtime.listFiles(".");
        if (files.length === 0) {
          return {
            reply: "The project root is empty.",
            suggestions: ["Show me git status"],
          };
        }
        const directories = files.filter((f) => f.type === "directory").map((f) => `${f.name}/`);
        const fileNames = files.filter((f) => f.type === "file").map((f) => f.name);
        const listing = [...directories, ...fileNames].join("\n");
        return {
          reply: `Files in project root:\n\n\`\`\`\n${listing}\n\`\`\``,
          suggestions: ["Read package.json", "Show me git status"],
        };
      }
      case "git_status": {
        const status = await runtime.gitStatus();
        const lines = [`Branch: ${status.branch}`, `Changed files: ${status.changedCount}`];
        if (status.changedFiles.length > 0) {
          lines.push("");
          lines.push(status.changedFiles.map((f) => `${f.status.padEnd(10)} ${f.path}`).join("\n"));
        }
        return {
          reply: lines.join("\n"),
          suggestions: ["Show me git diff", "List the files in the project root"],
        };
      }
      case "git_diff": {
        const diff = await runtime.gitDiff();
        const combined = [diff.stagedDiff, diff.diff].filter(Boolean).join("\n\n");
        if (!combined) {
          return {
            reply: "No changes detected in the working tree.",
            suggestions: ["Show me git status", "List the files in the project root"],
          };
        }
        const preview = combined.length > 4000
          ? combined.slice(0, 4000) + "\n\n... (truncated)"
          : combined;
        return {
          reply: `Current diff:\n\n\`\`\`diff\n${preview}\n\`\`\``,
          suggestions: ["Show me git status", "List the files in the project root"],
        };
      }
      case "inspect_project": {
        return performReadOnlyTaskLoop(runtime);
      }
      case "check_readiness": {
        return performLocalReadinessCheck(runtime);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown error";
    return {
      reply: `Workspace operation failed: ${reason}`,
      suggestions: ["Check workspace status in the activity panel"],
    };
  }

  return null;
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

    // Direct workspace actions bypass intent classification and delegation
    if (payload.projectId) {
      const directResult = await handleDirectWorkspaceRequest(payload.projectId, payload.message);
      if (directResult) {
        return NextResponse.json(
          {
            reply: directResult.reply,
            suggestions: directResult.suggestions,
            shouldDelegate: false,
            delegatePrompt: payload.message,
            intent: "read_only_inspection",
            allowedToolMode: "read-only",
            requiresExplicitApproval: false,
          },
          { status: 200 },
        );
      }
    }

    const intentDecision = await classifyIntent(payload.message);

    const shouldDelegate = intentDecision.shouldDelegate && intentDecision.allowedToolMode !== "none";

    if (shouldDelegate) {
      const ack = buildDelegationAcknowledgement(payload.message);
      return NextResponse.json(
        {
          reply: ack.reply,
          suggestions: ack.suggestions,
          shouldDelegate: true,
          delegatePrompt: payload.message,
          intent: intentDecision.intent,
          allowedToolMode: intentDecision.allowedToolMode,
          requiresExplicitApproval: intentDecision.requiresExplicitApproval,
        },
        { status: 200 },
      );
    }

    const prompt = buildChatPrompt(payload.history, payload.message, payload.attachments);
    const capabilityContext = await buildCapabilityContext(payload.projectId);

    let rawReply: string;

    if (intentDecision.allowedToolMode === "read-only" && payload.projectId) {
      const toolNames = getDefaultToolPreset();
      const task: AgentTask = {
        id: `main-chat-${requestId}`,
        agentId: "product" as AgentTask["agentId"],
        title: "Main chat read-only request",
        input: prompt,
        dependsOn: [],
        status: "pending",
      };
      const context: ToolContext = {
        projectId: payload.projectId,
        workspaceRoot: process.cwd(),
        requestId,
        actorId: "main-chat",
        actorRole: "assistant",
      };
      const result = await runAgentWithTools({
        systemPrompt: `${MAIN_AGENT_SYSTEM_PROMPT}\n\n${capabilityContext}`,
        userMessage: prompt,
        agentId: "main-chat",
        toolNames,
        context,
        task,
      });
      rawReply = result.output;
    } else {
      rawReply = await runAgentLLM(`${MAIN_AGENT_SYSTEM_PROMPT}\n\n${capabilityContext}`, prompt, undefined, payload.attachments ?? []);
    }

    const parsed = parseReply(rawReply);
    const reply = stripDelegationClaims(parsed.response);

    return NextResponse.json(
      {
        reply,
        suggestions: parsed.suggestions,
        shouldDelegate: false,
        delegatePrompt: payload.message,
        intent: intentDecision.intent,
        allowedToolMode: intentDecision.allowedToolMode,
        requiresExplicitApproval: intentDecision.requiresExplicitApproval,
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

    const message = error instanceof Error ? error.message : "Unknown error";
    return internalErrorResponse(`Failed to generate main agent reply: ${message}`, requestId);
  }
  })(request);
}
