import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, LanguageModel } from "ai";
import { withRetry } from "@/lib/reliability/retry";
import { getSecret } from "@/lib/security/secrets";

export type LLMProvider = "openai" | "anthropic" | "deepseek";

export type ChatImageAttachment = {
  name?: string;
  mimeType: string;
  dataUrl: string;
};

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  maxTokens: number;
}

const PROVIDER_DEFAULTS: Record<LLMProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-20241022",
  deepseek: "deepseek-chat",
};

function normalizeProvider(raw: string | undefined): LLMProvider {
  const provider = (raw ?? "openai").trim().toLowerCase();
  if (provider === "anthropic" || provider === "deepseek") {
    return provider;
  }
  return "openai";
}

function getProviderModel(provider: LLMProvider): string {
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_MODEL ?? PROVIDER_DEFAULTS.anthropic;
  }
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_MODEL ?? PROVIDER_DEFAULTS.deepseek;
  }
  return process.env.OPENAI_MODEL ?? PROVIDER_DEFAULTS.openai;
}

function getMissingKeyMessage(provider: LLMProvider): string {
  if (provider === "anthropic") {
    return "Replace the placeholder ANTHROPIC_API_KEY value in .env.local with a real secret to enable live AI responses.";
  }
  if (provider === "deepseek") {
    return "Set DEEPSEEK_API_KEY in .env.local (and optionally DEEPSEEK_BASE_URL / DEEPSEEK_MODEL) to enable live AI responses.";
  }
  return "Replace the placeholder OPENAI_API_KEY value in .env.local with a real secret to enable live AI responses.";
}

function buildFallbackReply(provider: LLMProvider, reason: string) {
  return [
    `[${provider} request failed — using safe fallback response]`,
    "",
    `Provider: ${provider}`,
    `Reason: ${reason}`,
    "",
    "Action: verify provider credentials, endpoint configuration, model compatibility, and billing status.",
  ].join("\n");
}

function hasProviderKey(provider: LLMProvider): boolean {
  if (provider === "anthropic") {
    return Boolean(getSecret("ANTHROPIC_API_KEY"));
  }
  if (provider === "deepseek") {
    return Boolean(getSecret("DEEPSEEK_API_KEY"));
  }
  return Boolean(getSecret("OPENAI_API_KEY"));
}

function getVisionFallbackConfigs(): LLMConfig[] {
  const fallbacks: LLMConfig[] = [];

  if (Boolean(getSecret("OPENAI_API_KEY"))) {
    fallbacks.push({
      provider: "openai",
      model: process.env.OPENAI_MODEL ?? PROVIDER_DEFAULTS.openai,
      maxTokens: Number(process.env.AI_MAX_TOKENS ?? 2048),
    });
  }

  if (Boolean(getSecret("ANTHROPIC_API_KEY"))) {
    fallbacks.push({
      provider: "anthropic",
      model: process.env.ANTHROPIC_MODEL ?? PROVIDER_DEFAULTS.anthropic,
      maxTokens: Number(process.env.AI_MAX_TOKENS ?? 2048),
    });
  }

  return fallbacks;
}

export function getDefaultLLMConfig(): LLMConfig {
  const provider = normalizeProvider(process.env.AI_PROVIDER);
  return {
    provider,
    model: getProviderModel(provider),
    maxTokens: Number(process.env.AI_MAX_TOKENS ?? 2048),
  };
}

export function getModel(config: LLMConfig): LanguageModel {
  if (config.provider === "anthropic") {
    const apiKey = getSecret("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("Missing Anthropic API key.");
    }
    const anthropic = createAnthropic({
      apiKey,
    });
    return anthropic(config.model);
  }

  const apiKey = getSecret("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }
  const openai = createOpenAI({
    apiKey,
  });
  return openai(config.model);
}

async function runDeepSeekChatCompletion(
  systemPrompt: string,
  userMessage: string,
  config: LLMConfig,
  attachments: ChatImageAttachment[] = [],
): Promise<string> {
  const apiKey = getSecret("DEEPSEEK_API_KEY");
  if (!apiKey) {
    throw new Error("Missing DeepSeek API key.");
  }

  const baseURL = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1";
  const endpoint = `${baseURL.replace(/\/+$/, "")}/chat/completions`;

  const response = await withRetry(
    async () =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content:
                attachments.length > 0
                  ? [
                      { type: "text", text: userMessage },
                      ...attachments.map((attachment) => ({
                        type: "image_url",
                        image_url: { url: attachment.dataUrl },
                      })),
                    ]
                  : userMessage,
            },
          ],
          max_tokens: config.maxTokens,
          temperature: 0.2,
          thinking: { type: "disabled" },
          stream: false,
        }),
      }),
    {
      retries: 2,
      minDelayMs: 200,
      maxDelayMs: 1600,
      shouldRetry: (error) => {
        if (!(error instanceof Error)) return false;
        const msg = error.message.toLowerCase();
        return msg.includes("timeout") || msg.includes("rate") || msg.includes("tempor") || msg.includes("503");
      },
    },
  );

  const textBody = await response.text();
  let payload: unknown = null;
  try {
    payload = textBody ? JSON.parse(textBody) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const apiMessage =
      typeof payload === "object" && payload && "error" in payload
        ? JSON.stringify((payload as { error: unknown }).error)
        : textBody.slice(0, 240);
    throw new Error(`DeepSeek API ${response.status}: ${apiMessage || "request failed"}`);
  }

  const content =
    typeof payload === "object" &&
    payload &&
    "choices" in payload &&
    Array.isArray((payload as { choices?: unknown[] }).choices)
      ? (payload as { choices: Array<{ message?: { content?: string } }> }).choices[0]?.message?.content
      : "";

  if (!content || !content.trim()) {
    throw new Error("DeepSeek API returned an empty response.");
  }

  return content;
}

function extractDeepSeekResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const asRecord = payload as Record<string, unknown>;
  const topLevelText = typeof asRecord.output_text === "string" ? asRecord.output_text.trim() : "";
  if (topLevelText) {
    return topLevelText;
  }

  const output = Array.isArray(asRecord.output) ? asRecord.output : [];
  const collected: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown[] }).content)
      ? ((item as { content?: unknown[] }).content ?? [])
      : [];

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim().length > 0) {
        collected.push(text.trim());
      }
    }
  }

  return collected.join("\n").trim();
}

async function runDeepSeekVisionResponse(
  systemPrompt: string,
  userMessage: string,
  config: LLMConfig,
  attachments: ChatImageAttachment[],
): Promise<string> {
  const apiKey = getSecret("DEEPSEEK_API_KEY");
  if (!apiKey) {
    throw new Error("Missing DeepSeek API key.");
  }

  const baseURL = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1";
  const endpoint = `${baseURL.replace(/\/+$/, "")}/responses`;
  const visionModel = process.env.DEEPSEEK_VISION_MODEL?.trim() || "deepseek-v4-flash";

  const response = await withRetry(
    async () =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: visionModel,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: systemPrompt }],
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: userMessage },
                ...attachments.map((attachment) => ({ type: "input_image", image_url: attachment.dataUrl })),
              ],
            },
          ],
          max_output_tokens: config.maxTokens,
          temperature: 0.2,
          thinking: { type: "disabled" },
          stream: false,
        }),
      }),
    {
      retries: 2,
      minDelayMs: 200,
      maxDelayMs: 1600,
      shouldRetry: (error) => {
        if (!(error instanceof Error)) return false;
        const msg = error.message.toLowerCase();
        return msg.includes("timeout") || msg.includes("rate") || msg.includes("tempor") || msg.includes("503");
      },
    },
  );

  const textBody = await response.text();
  let payload: unknown = null;
  try {
    payload = textBody ? JSON.parse(textBody) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const apiMessage =
      typeof payload === "object" && payload && "error" in payload
        ? JSON.stringify((payload as { error: unknown }).error)
        : textBody.slice(0, 240);
    throw new Error(`DeepSeek Responses API ${response.status}: ${apiMessage || "request failed"}`);
  }

  const content = extractDeepSeekResponsesText(payload);
  if (!content) {
    throw new Error("DeepSeek Responses API returned an empty response.");
  }

  return content;
}

async function runOpenAIChatCompletion(
  systemPrompt: string,
  userMessage: string,
  config: LLMConfig,
  attachments: ChatImageAttachment[] = [],
): Promise<string> {
  const apiKey = getSecret("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const response = await withRetry(
    async () =>
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content:
                attachments.length > 0
                  ? [
                      { type: "text", text: userMessage },
                      ...attachments.map((attachment) => ({
                        type: "image_url",
                        image_url: { url: attachment.dataUrl },
                      })),
                    ]
                  : userMessage,
            },
          ],
          max_tokens: config.maxTokens,
          temperature: 0.2,
        }),
      }),
    {
      retries: 2,
      minDelayMs: 200,
      maxDelayMs: 1600,
      shouldRetry: (error) => {
        if (!(error instanceof Error)) return false;
        const msg = error.message.toLowerCase();
        return msg.includes("timeout") || msg.includes("rate") || msg.includes("tempor") || msg.includes("503");
      },
    },
  );

  const textBody = await response.text();
  const payload = textBody ? JSON.parse(textBody) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown } : {};

  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${JSON.stringify(payload.error ?? textBody.slice(0, 240))}`);
  }

  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenAI API returned an empty response.");
  }

  return content;
}

async function runAnthropicMessage(
  systemPrompt: string,
  userMessage: string,
  config: LLMConfig,
  attachments: ChatImageAttachment[] = [],
): Promise<string> {
  const apiKey = getSecret("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Missing Anthropic API key.");
  }

  const response = await withRetry(
    async () =>
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          system: systemPrompt,
          max_tokens: config.maxTokens,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userMessage },
                ...attachments.map((attachment) => {
                  const [, meta, base64 = ""] = attachment.dataUrl.match(/^data:(.*?);base64,(.*)$/) ?? [];
                  return {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: meta || attachment.mimeType,
                      data: base64,
                    },
                  };
                }),
              ],
            },
          ],
        }),
      }),
    {
      retries: 2,
      minDelayMs: 200,
      maxDelayMs: 1600,
      shouldRetry: (error) => {
        if (!(error instanceof Error)) return false;
        const msg = error.message.toLowerCase();
        return msg.includes("timeout") || msg.includes("rate") || msg.includes("tempor") || msg.includes("503");
      },
    },
  );

  const textBody = await response.text();
  const payload = textBody ? JSON.parse(textBody) as { content?: Array<{ type?: string; text?: string }>; error?: unknown } : {};

  if (!response.ok) {
    throw new Error(`Anthropic API ${response.status}: ${JSON.stringify(payload.error ?? textBody.slice(0, 240))}`);
  }

  const content = payload.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n").trim();
  if (!content) {
    throw new Error("Anthropic API returned an empty response.");
  }

  return content;
}

export async function runAgentLLM(
  systemPrompt: string,
  userMessage: string,
  config?: Partial<LLMConfig>,
  attachments: ChatImageAttachment[] = [],
): Promise<string> {
  const resolved = { ...getDefaultLLMConfig(), ...config };

  const hasKey = hasProviderKey(resolved.provider);

  if (!hasKey) {
    // Return a structured stub so the app remains functional without a key
    return [
      `[No usable API key configured — simulated output for ${resolved.provider}]`,
      "",
      `System context: ${systemPrompt.slice(0, 120)}...`,
      `User request: ${userMessage.slice(0, 200)}`,
      "",
      getMissingKeyMessage(resolved.provider),
    ].join("\n");
  }

  if (resolved.provider === "deepseek") {
    try {
      if (attachments.length === 0) {
        return await runDeepSeekChatCompletion(systemPrompt, userMessage, resolved, attachments);
      }

      try {
        return await runDeepSeekVisionResponse(systemPrompt, userMessage, resolved, attachments);
      } catch (deepseekError) {
        const fallbackErrors: string[] = [];
        const visionFallbacks = getVisionFallbackConfigs();

        for (const fallback of visionFallbacks) {
          try {
            if (fallback.provider === "openai") {
              return await runOpenAIChatCompletion(systemPrompt, userMessage, fallback, attachments);
            }
            if (fallback.provider === "anthropic") {
              return await runAnthropicMessage(systemPrompt, userMessage, fallback, attachments);
            }
          } catch (fallbackError) {
            const reason = fallbackError instanceof Error ? fallbackError.message : "Unknown fallback error";
            fallbackErrors.push(`${fallback.provider}: ${reason}`);
          }
        }

        const deepseekReason = deepseekError instanceof Error ? deepseekError.message : "Unknown DeepSeek error";
        const reason = fallbackErrors.length > 0
          ? `${deepseekReason}; fallback failures -> ${fallbackErrors.join(" | ")}`
          : deepseekReason;
        return buildFallbackReply(resolved.provider, reason);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown DeepSeek error";
      return buildFallbackReply(resolved.provider, reason);
    }
  }

  if (attachments.length > 0 && resolved.provider === "openai") {
    try {
      return await runOpenAIChatCompletion(systemPrompt, userMessage, resolved, attachments);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown OpenAI error";
      return buildFallbackReply(resolved.provider, reason);
    }
  }

  if (attachments.length > 0 && resolved.provider === "anthropic") {
    try {
      return await runAnthropicMessage(systemPrompt, userMessage, resolved, attachments);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown Anthropic error";
      return buildFallbackReply(resolved.provider, reason);
    }
  }

  const model = getModel(resolved);
  const { text } = await withRetry(
    async () =>
      generateText({
        model,
        system: systemPrompt,
        prompt: userMessage,
        maxOutputTokens: resolved.maxTokens,
      }),
    {
      retries: 2,
      minDelayMs: 200,
      maxDelayMs: 1600,
      shouldRetry: (error) => {
        if (!(error instanceof Error)) return false;
        const msg = error.message.toLowerCase();
        return msg.includes("timeout") || msg.includes("rate") || msg.includes("tempor") || msg.includes("503");
      },
    },
  );

  return text;
}
