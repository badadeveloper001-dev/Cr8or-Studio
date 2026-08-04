import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, LanguageModel } from "ai";

export type LLMProvider = "openai" | "anthropic";

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  maxTokens: number;
}

function isUsableKey(value: string | undefined): value is string {
  return Boolean(value && value.trim().length > 0 && !value.includes("..."));
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
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    return anthropic(config.model);
  }

  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
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
      ? isUsableKey(process.env.ANTHROPIC_API_KEY)
      : isUsableKey(process.env.OPENAI_API_KEY);

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
  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: userMessage,
    maxOutputTokens: resolved.maxTokens,
  });

  return text;
}
