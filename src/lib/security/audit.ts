import { isFeatureEnabled } from "@/lib/config/feature-flags";

export type AuditAction =
  | "auth.login"
  | "auth.denied"
  | "route.access"
  | "route.denied"
  | "secret.access"
  | "policy.check"
  | "approval.request"
  | "approval.decision"
  | "approval.consume"
  | "sandbox.run"
  | "sandbox.violation"
  | "sandbox.cancel"
  | "sandbox.timeout"
  | "deploy.run"
  | "git.commit-push"
  | "github.api";

export type AuditOutcome = "allow" | "deny" | "error";

export type AuditEvent = {
  id: string;
  at: string;
  actorId: string;
  actorRole: string;
  action: AuditAction;
  outcome: AuditOutcome;
  route?: string;
  method?: string;
  reason?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

type AuditStore = {
  events: AuditEvent[];
};

declare global {
  var __cr8orAuditStore: AuditStore | undefined;
}

function getAuditStore(): AuditStore {
  if (!globalThis.__cr8orAuditStore) {
    globalThis.__cr8orAuditStore = {
      events: [],
    };
  }
  return globalThis.__cr8orAuditStore;
}

export function appendAuditEvent(event: AuditEvent) {
  if (!isFeatureEnabled("auditLog")) {
    return;
  }

  const store = getAuditStore();
  store.events.push(event);
  if (store.events.length > 5000) {
    store.events.splice(0, store.events.length - 5000);
  }
}

export function getAuditEvents(limit = 100): AuditEvent[] {
  const store = getAuditStore();
  return [...store.events].slice(-Math.max(1, Math.min(limit, 1000))).reverse();
}
