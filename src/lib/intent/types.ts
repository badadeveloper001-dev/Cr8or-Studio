export type IntentClass =
  | "conversation"
  | "explanation"
  | "brainstorming"
  | "planning"
  | "read_only_inspection"
  | "direct_action"
  | "specialist_delegation"
  | "high_risk_action"
  | "unclear";

export type ToolMode = "none" | "read-only" | "write";

export interface IntentDecision {
  intent: IntentClass;
  confidence: number;
  shouldUseTools: boolean;
  allowedToolMode: ToolMode;
  shouldDelegate: boolean;
  specialistId?: string;
  requiresExplicitApproval: boolean;
  reason: string;
}

export const INTENT_TOOL_MODE: Record<IntentClass, ToolMode> = {
  conversation: "none",
  explanation: "read-only",
  brainstorming: "none",
  planning: "none",
  read_only_inspection: "read-only",
  direct_action: "write",
  specialist_delegation: "write",
  high_risk_action: "write",
  unclear: "none",
} as const;

export const INTENT_SHOULD_DELEGATE: Record<IntentClass, boolean> = {
  conversation: false,
  explanation: false,
  brainstorming: false,
  planning: false,
  read_only_inspection: false,
  direct_action: true,
  specialist_delegation: true,
  high_risk_action: true,
  unclear: false,
} as const;

export const INTENT_REQUIRES_APPROVAL: Record<IntentClass, boolean> = {
  conversation: false,
  explanation: false,
  brainstorming: false,
  planning: false,
  read_only_inspection: false,
  direct_action: false,
  specialist_delegation: false,
  high_risk_action: true,
  unclear: false,
} as const;