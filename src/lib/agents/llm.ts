import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, LanguageModel } from "ai";
import { withRetry } from "@/lib/reliability/retry";
import { getSecret } from "@/lib/security/secrets";

export type LLMProvider = "openai" | "anthropic";

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  maxTokens: number;
}

export function getDefaultLLMConfig(): LLMConfig {
  const provider = (process.env.AI_PROVIDER ?? "openai") as LLMProvider;
  const modelMap: Record<LLMProvider, string> = {
    openai: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    anthropic: process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-20241022",
  };
  return {
    provider,
    model: modelMap[provider],
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

export async function runAgentLLM(
  systemPrompt: string,
  userMessage: string,
  config?: Partial<LLMConfig>,
): Promise<string> {
  const resolved = { ...getDefaultLLMConfig(), ...config };

  const hasKey =
    resolved.provider === "anthropic"
      ? Boolean(getSecret("ANTHROPIC_API_KEY"))
      : Boolean(getSecret("OPENAI_API_KEY"));

  if (!hasKey) {
    // Return a structured stub so the app remains functional without a key
    return [
      `[No usable API key configured — simulated output for ${resolved.provider}]`,
      "",
      `System context: ${systemPrompt.slice(0, 120)}...`,
      `User request: ${userMessage.slice(0, 200)}`,
      "",
      "Replace the placeholder OPENAI_API_KEY value in .env.local with a real secret to enable live AI responses.",
    ].join("\n");
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
