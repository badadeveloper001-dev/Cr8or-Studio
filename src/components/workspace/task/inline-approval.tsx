"use client";

import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

export function InlineApproval({
  title,
  actionLabel,
  details,
  meta,
  children,
  busy,
  approveLabel = "Approve once",
  rejectLabel = "Reject",
  onApprove,
  onReject,
}: {
  title: string;
  actionLabel?: string;
  details?: string;
  meta?: string[];
  children?: React.ReactNode;
  busy?: boolean;
  approveLabel?: string;
  rejectLabel?: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-lg border border-warning/40 bg-surface px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-text-primary">{title}</p>
          {actionLabel ? <p className="mt-0.5 font-mono text-[10px] text-text-muted">{actionLabel}</p> : null}
          {meta && meta.length > 0 ? (
            <p className="mt-0.5 text-[10px] text-text-muted">
              {meta.filter(Boolean).join(" · ")}
            </p>
          ) : null}
          {details ? (
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-2 font-mono text-[10px] leading-relaxed text-text-secondary">
              {details}
            </pre>
          ) : null}
          {children}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={onApprove} disabled={busy}>
              {approveLabel}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onReject} disabled={busy}>
              {rejectLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
