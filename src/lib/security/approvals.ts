import { randomUUID } from "node:crypto";

import { appendAuditEvent } from "@/lib/security/audit";
import { RiskAction } from "@/lib/security/policy";

export type ApprovalDecision = "approved" | "denied";
export type ApprovalStatus = "pending" | ApprovalDecision;

export type ApprovalRecord = {
  id: string;
  action: RiskAction;
  title: string;
  preview: string;
  requestedBy: string;
  requestedRole: string;
  requestedAt: string;
  status: ApprovalStatus;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  expiresAt: string;
  consumedAt?: string;
};

type ApprovalStore = {
  records: ApprovalRecord[];
};

declare global {
  var __cr8orApprovalStore: ApprovalStore | undefined;
}

const DEFAULT_TTL_MS = 1000 * 60 * 30;

function getStore(): ApprovalStore {
  if (!globalThis.__cr8orApprovalStore) {
    globalThis.__cr8orApprovalStore = { records: [] };
  }
  return globalThis.__cr8orApprovalStore;
}

function prune(records: ApprovalRecord[]): ApprovalRecord[] {
  const now = Date.now();
  return records.filter((record) => {
    if (record.status === "pending") {
      return new Date(record.expiresAt).getTime() > now;
    }
    return true;
  }).slice(-1000);
}

export function requestApproval(input: {
  action: RiskAction;
  title: string;
  preview: string;
  requestedBy: string;
  requestedRole: string;
  ttlMs?: number;
}): ApprovalRecord {
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const now = new Date();
  const record: ApprovalRecord = {
    id: randomUUID(),
    action: input.action,
    title: input.title,
    preview: input.preview,
    requestedBy: input.requestedBy,
    requestedRole: input.requestedRole,
    requestedAt: now.toISOString(),
    status: "pending",
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };

  const store = getStore();
  store.records = prune([...store.records, record]);

  appendAuditEvent({
    id: randomUUID(),
    at: now.toISOString(),
    actorId: input.requestedBy,
    actorRole: input.requestedRole,
    action: "approval.request",
    outcome: "allow",
    reason: `${input.action}|${record.id}`,
  });

  return record;
}

export function decideApproval(input: {
  id: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decidedRole: string;
  reason?: string;
}): ApprovalRecord | null {
  const store = getStore();
  const idx = store.records.findIndex((record) => record.id === input.id);
  if (idx < 0) return null;

  const current = store.records[idx];
  if (current.status !== "pending") return current;

  const updated: ApprovalRecord = {
    ...current,
    status: input.decision,
    decidedAt: new Date().toISOString(),
    decidedBy: input.decidedBy,
    reason: input.reason,
  };

  store.records[idx] = updated;
  store.records = prune(store.records);

  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: input.decidedBy,
    actorRole: input.decidedRole,
    action: "approval.decision",
    outcome: input.decision === "approved" ? "allow" : "deny",
    reason: `${updated.action}|${updated.id}|${input.decision}`,
  });

  return updated;
}

export function listApprovals(limit = 100): ApprovalRecord[] {
  const store = getStore();
  store.records = prune(store.records);
  return [...store.records].slice(-Math.max(1, Math.min(limit, 1000))).reverse();
}

export function consumeApprovalForAction(id: string, action: RiskAction): boolean {
  const store = getStore();
  const idx = store.records.findIndex((record) => record.id === id);
  if (idx < 0) return false;

  const record = store.records[idx];
  if (record.action !== action) return false;
  if (record.status !== "approved") return false;
  if (record.consumedAt) return false;
  if (new Date(record.expiresAt).getTime() <= Date.now()) return false;

  store.records[idx] = {
    ...record,
    consumedAt: new Date().toISOString(),
  };

  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: record.decidedBy ?? "unknown",
    actorRole: "owner",
    action: "approval.consume",
    outcome: "allow",
    reason: `${record.action}|${record.id}`,
  });

  return true;
}
