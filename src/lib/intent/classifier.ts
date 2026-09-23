import {
  IntentClass,
  IntentDecision,
  ToolMode,
  INTENT_TOOL_MODE,
  INTENT_SHOULD_DELEGATE,
  INTENT_REQUIRES_APPROVAL,
} from "@/lib/intent/types";

import { isImplementationRequest, isNonMutatingRequest, isPlanContinuation } from "@/lib/intent/execution-request";
export type { IntentClass, IntentDecision, ToolMode };
export { INTENT_TOOL_MODE, INTENT_SHOULD_DELEGATE, INTENT_REQUIRES_APPROVAL };

const HIGH_RISK_PATTERNS = [
  "commit",
  "push",
  "deploy",
  "delete",
  "remove",
  "destroy",
  "drop database",
  "drop table",
  "npm install",
  "yarn add",
  "pnpm add",
  "install package",
  "add dependency",
  "credentials",
  "secrets",
  "config",
  ".env",
];

const DELEGATION_PATTERNS = [
  "build",
  "implement",
  "refactor",
  "generate",
  "create",
  "fix",
  "run",
  "analyze",
  "audit",
  "scan",
  "review",
  "optimize",
  "redesign",
  "set up",
  "setup",
  "wire",
  "make",
  "add",
  "update",
  "change",
  "modify",
  "ship",
];

const EXPLORATORY_STARTS = [
  "what",
  "why",
  "how",
  "can you explain",
  "should we",
  "which",
  "tell me",
  "describe",
  "explain",
];

const PLANNING_PATTERNS = [
  "plan",
  "roadmap",
  "strategy",
  "approach",
  "design",
  "architecture",
  "spec",
  "specification",
  "proposal",
];

const CONVERSATION_PATTERNS = [
  "hello",
  "hi",
  "hey",
  "thanks",
  "thank you",
  "ok",
  "okay",
  "cool",
  "great",
  "nice",
  "bye",
  "goodbye",
  "see you",
  "how are you",
  "how's it going",
  "what's up",
];

const EXPLANATION_PATTERNS = [
  "explain",
  "what does",
  "what is",
  "how does",
  "why does",
  "what are",
  "define",
  "meaning of",
  "understand",
];

const BRAINSTORMING_PATTERNS = [
  "what do you think",
  "what do you think about",
  "should we",
  "ideas for",
  "opinion on",
  "thoughts on",
  "consider",
];

const POLITE_ACTION_PATTERNS = [
  "can you fix",
  "can you add",
  "can you update",
  "can you refactor",
  "can you change",
  "can you modify",
  "can you implement",
  "can you create",
  "can you build",
  "can you make",
  "can you write",
  "can you edit",
  "can you remove",
  "can you delete",
  "can you run",
  "can you execute",
  "can you deploy",
  "can you install",
  "can you configure",
  "can you set up",
  "could you fix",
  "could you add",
  "could you update",
  "could you refactor",
  "could you change",
  "could you modify",
  "could you implement",
  "could you create",
  "could you build",
  "could you make",
  "could you write",
  "could you edit",
  "could you remove",
  "could you delete",
  "could you run",
  "could you execute",
  "could you deploy",
  "could you install",
  "could you configure",
  "could you set up",
  "would you fix",
  "would you add",
  "would you update",
  "would you refactor",
  "would you change",
  "would you modify",
  "would you implement",
  "would you create",
  "would you build",
  "would you make",
  "would you write",
  "would you edit",
  "would you remove",
  "would you delete",
  "would you run",
  "would you execute",
  "would you deploy",
  "would you install",
  "would you configure",
  "would you set up",
  "please fix",
  "please add",
  "please update",
  "please refactor",
  "please change",
  "please modify",
  "please implement",
  "please create",
  "please build",
  "please make",
  "please write",
  "please edit",
  "please remove",
  "please delete",
  "please run",
  "please execute",
  "please deploy",
  "please install",
  "please configure",
  "please set up",
];

const TELL_ME_PATTERNS = [
  "can you tell me",
  "could you tell me",
  "would you tell me",
  "please tell me",
];

const READ_ONLY_INSPECTION_PATTERNS = [
  "check why",
  "what's wrong",
  "what is wrong",
  "why is",
  "why isn't",
  "why doesn't",
  "debug",
  "investigate",
  "diagnose",
];

const SPECIALIST_DELEGATION_PATTERNS = [
  "redesign",
  "architect",
  "design system",
  "build system",
  "implement feature",
  "create feature",
  "build feature",
];

const FOLLOWUP_PATTERNS = [
  "where are the results",
  "where is the result",
  "what did you find",
  "what did you find",
  "what did the",
  "show me the results",
  "show me the result",
  "show me what",
  "give me the result",
  "give me the results",
  "what were the results",
  "what were the findings",
  "summarize what",
  "summarize the",
  "what did you find",
  "what was found",
  "what did the inspection",
  "what did the review",
  "what did the analysis",
  "what did the scan",
  "results of the",
  "outcome of the",
  "findings of the",
];

const NEGATION_PATTERNS = [
  "don't build",
  "don't create",
  "don't implement",
  "don't fix",
  "don't change",
  "don't modify",
  "don't edit",
  "don't refactor",
  "don't add",
  "don't remove",
  "don't update",
  "don't deploy",
  "don't run",
  "don't execute",
  "do not build",
  "do not create",
  "do not implement",
  "do not fix",
  "do not change",
  "do not modify",
  "do not edit",
  "do not refactor",
  "do not add",
  "do not remove",
  "do not update",
  "do not deploy",
  "do not run",
  "do not execute",
  "never mind",
  "skip build",
  "skip create",
  "skip implementation",
];

const READ_ONLY_OVERRIDE_PATTERNS = [
  "just answer",
  "just explain",
  "just tell me",
  "just describe",
  "just show me",
  "only answer",
  "only explain",
  "only tell me",
  "only describe",
  "just read",
  "just look",
  "just check",
  "just analyze",
  "don't build anything",
  "don't build a",
  "don't create anything",
  "don't create a",
  "don't implement anything",
  "don't change anything",
  "don't modify anything",
  "don't edit anything",
  "don't fix anything",
  "don't run anything",
  "don't deploy anything",
];

const CAPABILITY_QUESTION_STARTS = [
  "can you build",
  "can you create",
  "can you make",
  "can you implement",
  "can you add",
  "can you fix",
  "can you edit",
  "can you deploy",
  "can you run",
  "can you execute",
  "can you set up",
  "could you build",
  "could you create",
  "could you make",
  "could you implement",
  "could you add",
  "could you fix",
  "could you edit",
  "could you deploy",
  "could you run",
  "could you execute",
  "could you set up",
  "would you build",
  "would you create",
  "would you make",
  "would you implement",
  "would you add",
  "would you fix",
  "would you edit",
  "would you deploy",
  "would you run",
  "would you execute",
  "would you set up",
];

const ACTION_REQUEST_INDICATORS = [
  "please",
  "go ahead",
  "do it",
  "start",
  "begin",
  "now",
  "right now",
  "immediately",
  "let's",
  "lets",
  "i need you to",
  "i want you to",
  "make sure",
  "get started",
];

function startsWithExploratory(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return EXPLORATORY_STARTS.some((start) => lower.startsWith(start));
}

function containsAny(message: string, patterns: string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function matchesHighRisk(message: string): boolean {
  return containsAny(message, HIGH_RISK_PATTERNS);
}

function matchesDelegation(message: string): boolean {
  return containsAny(message, DELEGATION_PATTERNS);
}

function matchesPlanning(message: string): boolean {
  return containsAny(message, PLANNING_PATTERNS);
}

function matchesConversation(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return CONVERSATION_PATTERNS.some((pattern) => {
    const patternWithSpace = pattern + " ";
    const patternWithComma = pattern + ",";
    return lower === pattern || lower.startsWith(patternWithSpace) || lower.startsWith(patternWithComma);
  });
}

function matchesExplanation(message: string): boolean {
  return containsAny(message, EXPLANATION_PATTERNS);
}

function matchesBrainstorming(message: string): boolean {
  return containsAny(message, BRAINSTORMING_PATTERNS);
}

function matchesPoliteAction(message: string): boolean {
  return containsAny(message, POLITE_ACTION_PATTERNS);
}

function matchesTellMe(message: string): boolean {
  return containsAny(message, TELL_ME_PATTERNS);
}

function matchesReadOnlyInspection(message: string): boolean {
  return containsAny(message, READ_ONLY_INSPECTION_PATTERNS);
}

function matchesSpecialistDelegation(message: string): boolean {
  return containsAny(message, SPECIALIST_DELEGATION_PATTERNS);
}

function matchesFollowup(message: string): boolean {
  return containsAny(message, FOLLOWUP_PATTERNS);
}

function hasNegationOverride(message: string): boolean {
  return containsAny(message, NEGATION_PATTERNS);
}

function hasReadOnlyOverride(message: string): boolean {
  return containsAny(message, READ_ONLY_OVERRIDE_PATTERNS);
}

function matchesCapabilityQuestion(message: string): boolean {
  const lower = message.toLowerCase().trim();
  if (!lower.endsWith("?")) return false;
  if (!containsAny(lower, CAPABILITY_QUESTION_STARTS)) return false;
  if (containsAny(lower, ACTION_REQUEST_INDICATORS)) return false;
  return true;
}

function isQuestion(message: string): boolean {
  return message.trim().endsWith("?") || startsWithExploratory(message);
}

function hasActionVerb(message: string): boolean {
  const actionVerbs = [
    "fix",
    "change",
    "implement",
    "add",
    "remove",
    "refactor",
    "update",
    "create",
    "delete",
    "modify",
    "write",
    "edit",
    "run",
    "execute",
    "build",
    "deploy",
    "install",
    "configure",
    "set up",
    "redesign",
  ];
  return containsAny(message, actionVerbs);
}

function buildDecision(
  intent: IntentClass,
  confidence: number,
  overrides?: Partial<IntentDecision>
): IntentDecision {
  return {
    intent,
    confidence,
    shouldUseTools: (INTENT_TOOL_MODE as Record<IntentClass, ToolMode>)[intent] !== "none",
    allowedToolMode: (INTENT_TOOL_MODE as Record<IntentClass, ToolMode>)[intent],
    shouldDelegate: (INTENT_SHOULD_DELEGATE as Record<IntentClass, boolean>)[intent],
    requiresExplicitApproval: (INTENT_REQUIRES_APPROVAL as Record<IntentClass, boolean>)[intent],
    reason: `Classified as ${intent} (${confidence}% confidence)`,
    ...overrides,
  };
}

export function classifyIntentDeterministic(message: string, previousContext = ""): IntentDecision {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  if (trimmed.length < 3) {
    return buildDecision("unclear", 30, { reason: "Message too short to classify" });
  }

  if (isNonMutatingRequest(trimmed)) {
    return buildDecision("read_only_inspection", 95, { reason: "Requested analysis or prose, not workspace mutation" });
  }
  if (isImplementationRequest(trimmed, previousContext)) {
    const positive = lower.replace(/\b(?:do not|don't|never)\b[^.!;\n]*/g, "");
    if (matchesHighRisk(positive)) return buildDecision("high_risk_action", 95);
    return buildDecision("direct_action", 95, { reason: "Current turn requests implementation; tool policy still applies" });
  }
  if (isPlanContinuation(trimmed)) {
    return buildDecision("explanation", 95, { reason: "No recent pending implementation proposal supports this continuation" });
  }

  // Negation overrides: explicit "don't build/fix/etc." or "just answer/explain"
  // must NOT delegate regardless of action words present
  if (hasNegationOverride(lower) || hasReadOnlyOverride(lower)) {
    if (matchesReadOnlyInspection(lower) || lower.includes("wrong") || lower.includes("broken") || lower.includes("error") || lower.includes("bug")) {
      return buildDecision("read_only_inspection", 85, { reason: "Negation/override detected with diagnostic context" });
    }
    return buildDecision("explanation", 85, { reason: "Negation/override detected — conversation only" });
  }

  // High risk actions checked first
  if (matchesHighRisk(lower) && hasActionVerb(lower)) {
    return buildDecision("high_risk_action", 90);
  }

  // Conversation - highest priority for greetings
  if (matchesConversation(trimmed)) {
    return buildDecision("conversation", 95);
  }

  // Follow-up questions about previous results - check before other patterns
  // These should NOT delegate and should use the last orchestration result
  if (matchesFollowup(lower)) {
    return buildDecision("followup_result", 90);
  }

  // Polite action requests - "Can you fix...", "Could you add...", etc.
  // BUT capability questions like "Can you build a website?" without action intent
  // should be treated as explanation, not delegation.
  if (matchesPoliteAction(lower) && hasActionVerb(lower)) {
    if (matchesCapabilityQuestion(lower)) {
      return buildDecision("explanation", 85, { reason: "Capability question — no action intent detected" });
    }
    return buildDecision("direct_action", 90);
  }

  // Specialist delegation - check before general delegation
  if (matchesSpecialistDelegation(lower) && hasActionVerb(lower)) {
    return buildDecision("specialist_delegation", 85);
  }

  // Direct read-only inspection patterns
  if (matchesReadOnlyInspection(lower)) {
    return buildDecision("read_only_inspection", 85);
  }

  // Brainstorming patterns
  if (matchesBrainstorming(lower)) {
    return buildDecision("brainstorming", 80);
  }

  // Planning patterns - check before general delegation
  if (matchesPlanning(lower) && isQuestion(trimmed)) {
    return buildDecision("planning", 80);
  }
  if (matchesPlanning(lower) && hasActionVerb(lower) && lower.includes("create a plan")) {
    return buildDecision("planning", 85);
  }

  // Questions
  if (isQuestion(trimmed)) {
    // Polite action requests - "Can you fix...", "Could you add..."
    // BUT capability questions should be explanation, not delegation
    if (matchesPoliteAction(lower) && hasActionVerb(lower)) {
      if (matchesCapabilityQuestion(lower)) {
        return buildDecision("explanation", 85, { reason: "Capability question — no action intent detected" });
      }
      return buildDecision("direct_action", 90);
    }

    // Tell-me patterns - "Can you tell me...", "Could you tell me..."
    // These are explanation/read-only, NOT brainstorming
    if (matchesTellMe(lower)) {
      if (matchesReadOnlyInspection(lower) || lower.includes("wrong") || lower.includes("broken") || lower.includes("fail") || lower.includes("error") || lower.includes("bug")) {
        return buildDecision("read_only_inspection", 80);
      }
      return buildDecision("explanation", 80);
    }

    // Read-only inspection for diagnostic questions
    if (matchesReadOnlyInspection(lower) || lower.includes("wrong") || lower.includes("broken") || lower.includes("fail") || lower.includes("error") || lower.includes("bug")) {
      return buildDecision("read_only_inspection", 80);
    }
    // Brainstorming for opinion/idea questions
    if (matchesBrainstorming(lower)) {
      return buildDecision("brainstorming", 80);
    }
    // Explanation for "how/what/why does/are/is" questions
    if (matchesExplanation(lower)) {
      return buildDecision("explanation", 75);
    }
    // Exploratory starts (what/why/how) without specific patterns
    if (startsWithExploratory(trimmed)) {
      return buildDecision("brainstorming", 70);
    }
    return buildDecision("brainstorming", 65);
  }

  // Delegation with action verbs - direct action or specialist
  if (matchesDelegation(lower) && hasActionVerb(lower)) {
    if (matchesSpecialistDelegation(lower)) {
      return buildDecision("specialist_delegation", 85);
    }
    return buildDecision("direct_action", 85);
  }

  // Planning without question
  if (matchesPlanning(lower)) {
    return buildDecision("planning", 70);
  }

  // Explanation statements
  if (matchesExplanation(lower)) {
    return buildDecision("explanation", 75);
  }

  return buildDecision("unclear", 50, { reason: "No clear pattern matched" });
}

export function validateIntentDecision(decision: IntentDecision): IntentDecision {
  if (decision.confidence < 0 || decision.confidence > 100) {
    decision.confidence = Math.max(0, Math.min(100, decision.confidence));
  }

  const expectedToolMode = (INTENT_TOOL_MODE as Record<IntentClass, ToolMode>)[decision.intent];
  const expectedDelegate = (INTENT_SHOULD_DELEGATE as Record<IntentClass, boolean>)[decision.intent];
  const expectedApproval = (INTENT_REQUIRES_APPROVAL as Record<IntentClass, boolean>)[decision.intent];

  if (decision.allowedToolMode !== expectedToolMode) {
    decision.allowedToolMode = expectedToolMode;
    decision.shouldUseTools = expectedToolMode !== "none";
  }

  if (decision.shouldDelegate !== expectedDelegate) {
    decision.shouldDelegate = expectedDelegate;
  }

  if (decision.requiresExplicitApproval !== expectedApproval) {
    decision.requiresExplicitApproval = expectedApproval;
  }

  return decision;
}
