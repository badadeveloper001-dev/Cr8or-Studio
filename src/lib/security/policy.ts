import { randomUUID } from "node:crypto";

import { appendAuditEvent } from "@/lib/security/audit";
import { consumeApprovalForAction } from "@/lib/security/approvals";

export type PolicyProfile = "strict" | "balanced" | "autonomous";
export type RiskLevel = "low" | "medium" | "high";

export type RiskAction =
  | "files.write"
  | "git.commit-push"
  | "github.write"
  | "deploy.vercel"
  | "project.create"
  | "project.clone";

type PolicyStore = {
  profile: PolicyProfile;
};

declare global {
  var __cr8orPolicyStore: PolicyStore | undefined;
}

const ACTION_RISK: Record<RiskAction, RiskLevel> = {
  "files.write": "medium",
  "git.commit-push": "high",
  "github.write": "high",
  "deploy.vercel": "high",
  "project.create": "low",
  "project.clone": "medium",
};

function getDefaultProfile(): PolicyProfile {
  const value = (process.env.CR8OR_POLICY_PROFILE ?? "balanced").trim().toLowerCase();
  if (value === "strict" || value === "autonomous") {
    return value;
  }
  return "balanced";
}

function getStore(): PolicyStore {
  if (!globalThis.__cr8orPolicyStore) {
    globalThis.__cr8orPolicyStore = {
      profile: getDefaultProfile(),
    };
  }
  return globalThis.__cr8orPolicyStore;
}

export function getPolicyProfile(): PolicyProfile {
  return getStore().profile;
}

export function setPolicyProfile(profile: PolicyProfile): PolicyProfile {
  const store = getStore();
  store.profile = profile;
  return store.profile;
}

function requiresApproval(profile: PolicyProfile, risk: RiskLevel): boolean {
  if (profile === "autonomous") return false;
  if (profile === "strict") return risk === "medium" || risk === "high";
  return risk === "high";
}

export type PolicyGuardInput = {
  action: RiskAction;
  requestId?: string;
  actorId?: string;
  actorRole?: string;
  approvalId?: string;
};

export type PolicyGuardResult =
  | {
      allowed: true;
      profile: PolicyProfile;
      risk: RiskLevel;
      approvalRequired: boolean;
      approvalConsumed: boolean;
    }
  | {
      allowed: false;
      profile: PolicyProfile;
      risk: RiskLevel;
      approvalRequired: boolean;
      reason: string;
    };

export function evaluatePolicyGuard(input: PolicyGuardInput): PolicyGuardResult {
  const profile = getPolicyProfile();
  const risk = ACTION_RISK[input.action];
  const approvalRequired = requiresApproval(profile, risk);

  if (!approvalRequired) {
    appendAuditEvent({
      id: randomUUID(),
      at: new Date().toISOString(),
      actorId: input.actorId ?? "unknown",
      actorRole: input.actorRole ?? "unknown",
      action: "policy.check",
      outcome: "allow",
      reason: `profile:${profile}|action:${input.action}|risk:${risk}|approval:not-required`,
      requestId: input.requestId,
    });

    return {
      allowed: true,
      profile,
      risk,
      approvalRequired,
      approvalConsumed: false,
    };
  }

  if (!input.approvalId) {
    appendAuditEvent({
      id: randomUUID(),
      at: new Date().toISOString(),
      actorId: input.actorId ?? "unknown",
      actorRole: input.actorRole ?? "unknown",
      action: "policy.check",
      outcome: "deny",
      reason: `profile:${profile}|action:${input.action}|risk:${risk}|approval:missing`,
      requestId: input.requestId,
    });

    return {
      allowed: false,
      profile,
      risk,
      approvalRequired,
      reason: "Approval is required for this action.",
    };
  }

  const consumed = consumeApprovalForAction(input.approvalId, input.action);
  if (!consumed) {
    appendAuditEvent({
      id: randomUUID(),
      at: new Date().toISOString(),
      actorId: input.actorId ?? "unknown",
      actorRole: input.actorRole ?? "unknown",
      action: "policy.check",
      outcome: "deny",
      reason: `profile:${profile}|action:${input.action}|risk:${risk}|approval:invalid`,
      requestId: input.requestId,
    });

    return {
      allowed: false,
      profile,
      risk,
      approvalRequired,
      reason: "Approval is missing, expired, or already used.",
    };
  }

  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: input.actorId ?? "unknown",
    actorRole: input.actorRole ?? "unknown",
    action: "policy.check",
    outcome: "allow",
    reason: `profile:${profile}|action:${input.action}|risk:${risk}|approval:consumed`,
    requestId: input.requestId,
  });

  return {
    allowed: true,
    profile,
    risk,
    approvalRequired,
    approvalConsumed: true,
  };
}

export function getPolicyRules() {
  return {
    strict: {
      low: "allow",
      medium: "requires-approval",
      high: "requires-approval",
    },
    balanced: {
      low: "allow",
      medium: "allow",
      high: "requires-approval",
    },
    autonomous: {
      low: "allow",
      medium: "allow",
      high: "allow",
    },
  };
}
