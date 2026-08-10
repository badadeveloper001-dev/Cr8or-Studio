import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, LanguageModel } from "ai";
import { withRetry } from "@/lib/reliability/retry";
import { getSecret } from "@/lib/security/secrets";

export type LLMProvider = "openai" | "anthropic" | "deepseek";

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

function hasProviderKey(provider: LLMProvider): boolean {
  if (provider === "anthropic") {
    return Boolean(getSecret("ANTHROPIC_API_KEY"));
  }
  if (provider === "deepseek") {
    return Boolean(getSecret("DEEPSEEK_API_KEY"));
  }
  return Boolean(getSecret("OPENAI_API_KEY"));
}

export function getDefaultLLMConfig(): LLMConfig {
  const provider = normalizeProvider(process.env.AI_PROVIDER);
  return {
    provider,
    model: getProviderModel(provider),
    maxTokens: Number(process.env.AI_MAX_TOKENS ?? 2048),
  };
}

function getModel(config: LLMConfig): LanguageModel {
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
            { role: "user", content: userMessage },
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

export async function runAgentLLM(
  systemPrompt: string,
  userMessage: string,
  config?: Partial<LLMConfig>,
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
      return await runDeepSeekChatCompletion(systemPrompt, userMessage, resolved);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown DeepSeek error";
      return [
        "[DeepSeek request failed — using safe fallback response]",
        "",
        `Provider: ${resolved.provider}`,
        `Reason: ${reason}`,
        "",
        "Action: verify DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, and model compatibility.",
      ].join("\n");
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
