"use client";

import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Eye,
  FolderTree,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ReviewToolbar({
  fileCount,
  branch,
  hasActiveFile,
  isBusy,
  canPrev,
  canNext,
  onClose,
  onRefresh,
  onStage,
  onUnstage,
  onPrev,
  onNext,
  onOpenFiles,
  commitMessage,
  onCommitMessageChange,
  onPreviewCommit,
  onCommitPush,
}: {
  fileCount: number;
  branch: string;
  hasActiveFile: boolean;
  isBusy: boolean;
  canPrev: boolean;
  canNext: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenFiles: () => void;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onPreviewCommit: () => void;
  onCommitPush: () => void;
}) {
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-strong bg-surface px-2 sm:px-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="gap-1.5 text-text-secondary"
          aria-label="Back to task"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </Button>

        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-text-primary">Review changes</p>
          <p className="truncate text-[10px] text-text-muted">
            {branch || "unknown branch"} · {fileCount} {fileCount === 1 ? "file" : "files"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1 md:hidden">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onOpenFiles}
            className="h-9 gap-1.5 text-text-secondary"
            aria-label="Select file"
          >
            <FolderTree className="h-4 w-4" />
            <span className="hidden sm:inline">Files</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onPrev}
            disabled={!canPrev}
            className="h-9 w-9 p-0 text-text-secondary"
            aria-label="Previous file"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onNext}
            disabled={!canNext}
            className="h-9 w-9 p-0 text-text-secondary"
            aria-label="Next file"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="ml-auto hidden items-center gap-1.5 md:flex">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={isBusy}
            className="gap-1.5 text-text-muted"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isBusy && "animate-spin")} />
            Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onStage}
            disabled={isBusy || !hasActiveFile}
            className="gap-1.5 text-text-secondary"
          >
            <Plus className="h-3.5 w-3.5" />
            Stage
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onUnstage}
            disabled={isBusy || !hasActiveFile}
            className="gap-1.5 text-text-secondary"
          >
            <Minus className="h-3.5 w-3.5" />
            Unstage
          </Button>

          <div className="hidden items-center gap-1.5 xl:flex">
            <span className="mx-1 h-5 w-px bg-border-strong" aria-hidden />
            <input
              type="text"
              value={commitMessage}
              onChange={(event) => onCommitMessageChange(event.target.value)}
              placeholder="Commit message"
              aria-label="Commit message"
              className="h-8 w-56 rounded-md border border-border-strong bg-surface px-2 text-[11px] text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onPreviewCommit}
              disabled={isBusy}
              className="gap-1.5"
            >
              <Eye className="h-3.5 w-3.5" />
              Preview
            </Button>
            <Button type="button" size="sm" onClick={onCommitPush} disabled={isBusy} className="gap-1.5">
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              Commit &amp; Push
            </Button>
          </div>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-strong bg-surface px-2 py-1.5 md:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onStage}
          disabled={isBusy || !hasActiveFile}
          className="h-9 flex-1 gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Stage
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onUnstage}
          disabled={isBusy || !hasActiveFile}
          className="h-9 flex-1 gap-1.5"
        >
          <Minus className="h-3.5 w-3.5" />
          Unstage
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isBusy}
          className="h-9 w-9 p-0 text-text-muted"
          aria-label="Refresh changes"
        >
          <RefreshCw className={cn("h-4 w-4", isBusy && "animate-spin")} />
        </Button>
      </div>
    </>
  );
}
