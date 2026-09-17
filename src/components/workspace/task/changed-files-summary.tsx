"use client";

import { FileDiff } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";

export function ChangedFilesSummary({ onReviewChanges }: { onReviewChanges?: () => void }) {
  const { gitSnapshot } = useWorkspaceControllerContext();

  if (!gitSnapshot || gitSnapshot.changedCount === 0 || gitSnapshot.changedFiles.length === 0) {
    return null;
  }

  const files = gitSnapshot.changedFiles.slice(0, 5);

  return (
    <div className="rounded-lg border border-border-strong bg-surface px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-primary">
          <FileDiff className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="truncate">
            {gitSnapshot.changedCount} {gitSnapshot.changedCount === 1 ? "file" : "files"} changed
          </span>
        </p>
        {onReviewChanges ? (
          <button
            type="button"
            onClick={onReviewChanges}
            className="shrink-0 text-[11px] text-accent hover:underline"
          >
            Review changes
          </button>
        ) : null}
      </div>
      <p className="mt-0.5 text-[10px] text-text-muted">Branch {gitSnapshot.branch || "unknown"}</p>
      {gitSnapshot.changedCount > files.length ? (
        <p className="mt-1 text-[10px] text-text-muted">
          Showing {files.length} of {gitSnapshot.changedCount}.
        </p>
      ) : null}
      <ul className="mt-2 space-y-0.5">
        {files.map((change) => (
          <li key={`${change.status}-${change.path}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">{change.path}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">{change.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
