import { z } from "zod";

import { runAgentLLM, getDefaultLLMConfig } from "@/lib/agents/llm";
import type { IntentDecision } from "@/lib/intent/types";
import { validateIntentDecision, INTENT_TOOL_MODE, INTENT_SHOULD_DELEGATE, INTENT_REQUIRES_APPROVAL, classifyIntentDeterministic } from "@/lib/intent/classifier";

const INTENT_SCHEMA = z.object({
  intent: z.enum([
    "conversation",
    "explanation",
    "brainstorming",
    "planning",
    "read_only_inspection",
    "direct_action",
    "specialist_delegation",
    "high_risk_action",
    "followup_result",
    "unclear",
  ]),
  confidence: z.number().min(0).max(100),
  reason: z.string().min(10).max(500),
});

const CLASSIFIER_SYSTEM_PROMPT = `
You are an intent classifier for Cr8or AI. Classify the user's message into exactly ONE intent category.

Categories:
- conversation: Greetings, casual chat, thanks, simple acknowledgments
- explanation: User wants to understand something ("explain X", "how does Y work", "what is Z")
- brainstorming: Open-ended discussion, seeking opinions ("what do you think", "should we", "ideas for")
- planning: Requesting a plan/roadmap/strategy without immediate execution ("plan for", "roadmap", "approach")
- read_only_inspection: Diagnosing issues without fixing ("check why", "what's wrong", "debug", "investigate")
- direct_action: Clear execution intent with action verbs ("fix", "implement", "add", "update", "refactor", "create")
- specialist_delegation: Complex multi-faceted tasks needing specialist ownership ("redesign", "build system", "implement feature")
- high_risk_action: Destructive or irreversible actions ("delete", "commit", "push", "deploy", "drop", "destroy")
- followup_result: Asking about results of a previous run ("where are the results", "what did you find", "what did you find", "show me the results")
- unclear: Cannot determine from message alone

Rules:
- Prefer conversation/explanation/brainstorming/planning when user is asking, not directing
- Prefer read_only_inspection for diagnostic language without action verbs
- Require clear action verbs (fix, implement, add, change, etc.) for direct_action
- High risk needs explicit destructive/irreversible language
- Follow-up questions about previous results should be classified as followup_result
- Confidence 0-100
- Brief reason (1-2 sentences)
`;

function buildClassifierPrompt(message: string): string {
  return `User message: "${message}"\n\nClassify intent and provide confidence + reason.`;
}

export async function classifyIntentWithLLM(message: string): Promise<IntentDecision | null> {
  const config = getDefaultLLMConfig();
  
  const hasKey = 
    (config.provider === "openai" && process.env.OPENAI_API_KEY) ||
    (config.provider === "anthropic" && process.env.ANTHROPIC_API_KEY) ||
    (config.provider === "deepseek" && process.env.DEEPSEEK_API_KEY);

  if (!hasKey) {
    return null;
  }

  try {
    const raw = await runAgentLLM(
      CLASSIFIER_SYSTEM_PROMPT,
      buildClassifierPrompt(message),
      { maxTokens: 200 }
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : raw;
    const parsed = JSON.parse(jsonStr);
    const validated = INTENT_SCHEMA.parse(parsed);

    return validateIntentDecision({
      intent: validated.intent,
      confidence: validated.confidence,
      shouldUseTools: false,
      allowedToolMode: INTENT_TOOL_MODE[validated.intent],
      shouldDelegate: INTENT_SHOULD_DELEGATE[validated.intent],
      requiresExplicitApproval: INTENT_REQUIRES_APPROVAL[validated.intent],
      reason: validated.reason,
    });
  } catch {
    return null;
  }
}

export async function classifyIntent(message: string): Promise<IntentDecision> {
  const deterministic = classifyIntentDeterministic(message);

  if (deterministic.intent !== "unclear" && deterministic.confidence >= 80) {
    return deterministic;
  }

  if (deterministic.intent === "unclear" || deterministic.confidence < 70) {
    const llmDecision = await classifyIntentWithLLM(message);
    if (llmDecision && llmDecision.confidence > deterministic.confidence) {
      return llmDecision;
    }
  }

  return deterministic;
}

export { classifyIntentDeterministic, validateIntentDecision } from "./classifier";