"use client";

import { FolderTree, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { describeGitStatus } from "@/components/workspace/review/diff-utils";
import { cn } from "@/lib/utils";

export type ReviewFile = {
  path: string;
  status: string;
};

export function ReviewFileList({
  files,
  activePath,
  isBusy,
  onSelect,
  onRefresh,
  className,
}: {
  files: ReviewFile[];
  activePath: string;
  isBusy: boolean;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-strong pl-3 pr-1.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
          {files.length} {files.length === 1 ? "file" : "files"}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isBusy}
          className="gap-1.5 text-text-muted"
          aria-label="Refresh changes"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isBusy && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {files.length === 0 ? (
        <p className="px-3 py-4 text-xs leading-relaxed text-text-muted">Working tree is clean.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
          {files.map((file) => {
            const isActive = file.path === activePath;
            const status = describeGitStatus(file.status);
            return (
              <li key={`${file.status}:${file.path}`}>
                <button
                  type="button"
                  onClick={() => onSelect(file.path)}
                  aria-current={isActive ? "true" : undefined}
                  title={`${status.label} — ${file.path}`}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    isActive
                      ? "bg-surface-muted text-text-primary"
                      : "text-text-secondary hover:bg-surface-muted hover:text-text-primary",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-surface-raised font-mono text-[10px] font-semibold",
                      status.tone,
                    )}
                  >
                    {status.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.path}</span>
                  <span className="sr-only">{status.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ReviewFileListEmpty({ onRefresh, isBusy }: { onRefresh: () => void; isBusy: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <FolderTree className="h-6 w-6 text-text-muted" />
      <p className="text-sm text-text-secondary">Working tree is clean.</p>
      <p className="text-xs text-text-muted">No staged or unstaged changes to review.</p>
      <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={isBusy} className="mt-1 gap-1.5">
        <RefreshCw className={cn("h-3.5 w-3.5", isBusy && "animate-spin")} />
        Refresh
      </Button>
    </div>
  );
}
