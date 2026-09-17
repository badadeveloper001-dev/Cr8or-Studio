"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { MobileSheet } from "@/components/workspace/mobile-sheet";
import { DiffViewer, type DiffSide } from "@/components/workspace/review/diff-viewer";
import { parseUnifiedDiff } from "@/components/workspace/review/diff-utils";
import { ReviewFileList, ReviewFileListEmpty } from "@/components/workspace/review/review-file-list";
import { ReviewToolbar } from "@/components/workspace/review/review-toolbar";

export function ReviewMode({
  open,
  initialPath,
  onClose,
}: {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
}) {
  const {
    gitSnapshot,
    selectedDiffPath,
    diffPreview,
    stagedDiffPreview,
    isDiffBusy,
    isGitBusy,
    loadDiffPreview,
    stageFile,
    runGitStatus,
    gitCommitMessage,
    setGitCommitMessage,
    previewCommitPush,
    runCommitPush,
  } = useWorkspaceControllerContext();

  const files = useMemo(() => gitSnapshot?.changedFiles ?? [], [gitSnapshot]);
  const [side, setSide] = useState<DiffSide>("unstaged");
  const [filesOpen, setFilesOpen] = useState(false);
  const appliedInitial = useRef(false);

  const unstaged = useMemo(() => parseUnifiedDiff(diffPreview), [diffPreview]);
  const staged = useMemo(() => parseUnifiedDiff(stagedDiffPreview), [stagedDiffPreview]);

  useEffect(() => {
    if (open) return;
    setFilesOpen(false);
    appliedInitial.current = false;
  }, [open]);

  useEffect(() => {
    if (open && !gitSnapshot && !isGitBusy) void runGitStatus();
  }, [open, gitSnapshot, isGitBusy, runGitStatus]);

  useEffect(() => {
    if (!open || files.length === 0) return;
    const hasSelected = files.some((file) => file.path === selectedDiffPath);
    const preferInitial =
      !appliedInitial.current && Boolean(initialPath) && files.some((file) => file.path === initialPath);
    const target = preferInitial ? initialPath : hasSelected ? selectedDiffPath : files[0].path;
    if (preferInitial) appliedInitial.current = true;
    if (target && target !== selectedDiffPath) void loadDiffPreview(target);
  }, [open, files, initialPath, selectedDiffPath, loadDiffPreview]);

  useEffect(() => {
    if (!selectedDiffPath) return;
    if (side === "unstaged" && unstaged.empty && !staged.empty) setSide("staged");
    else if (side === "staged" && staged.empty && !unstaged.empty) setSide("unstaged");
  }, [selectedDiffPath, side, unstaged.empty, staged.empty]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !filesOpen) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, filesOpen, onClose]);

  if (!open) return null;

  const activeIndex = files.findIndex((file) => file.path === selectedDiffPath);
  const activeFile = activeIndex >= 0 ? files[activeIndex] : undefined;
  const canNavigate = files.length > 1;
  const isInitialLoading = !gitSnapshot && isGitBusy;

  const selectFile = (path: string) => {
    setFilesOpen(false);
    void loadDiffPreview(path);
  };

  const goTo = (delta: number) => {
    if (files.length === 0) return;
    const base = activeIndex < 0 ? 0 : activeIndex;
    const nextIndex = (base + delta + files.length) % files.length;
    void loadDiffPreview(files[nextIndex].path);
  };

  const stage = () => {
    if (activeFile) void stageFile(activeFile.path, "stage");
  };

  const unstage = () => {
    if (activeFile) void stageFile(activeFile.path, "unstage");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review changes"
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <ReviewToolbar
        fileCount={files.length}
        branch={gitSnapshot?.branch ?? ""}
        hasActiveFile={Boolean(activeFile)}
        isBusy={isGitBusy || isDiffBusy}
        canPrev={canNavigate}
        canNext={canNavigate}
        onClose={onClose}
        onRefresh={() => void runGitStatus()}
        onStage={stage}
        onUnstage={unstage}
        onPrev={() => goTo(-1)}
        onNext={() => goTo(1)}
        onOpenFiles={() => setFilesOpen(true)}
        commitMessage={gitCommitMessage}
        onCommitMessageChange={setGitCommitMessage}
        onPreviewCommit={() => void previewCommitPush()}
        onCommitPush={() => void runCommitPush()}
      />

      <div className="flex min-h-0 flex-1">
        {files.length > 0 ? (
          <ReviewFileList
            files={files}
            activePath={selectedDiffPath}
            isBusy={isGitBusy}
            onSelect={selectFile}
            onRefresh={() => void runGitStatus()}
            className="hidden w-72 shrink-0 border-r border-border-strong bg-surface md:flex xl:w-80"
          />
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isInitialLoading ? (
            <div className="flex items-center gap-2 px-4 py-5 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading changes…
            </div>
          ) : files.length === 0 ? (
            <ReviewFileListEmpty onRefresh={() => void runGitStatus()} isBusy={isGitBusy} />
          ) : (
            <DiffViewer
              path={activeFile?.path ?? ""}
              status={activeFile?.status}
              loading={isDiffBusy}
              side={side}
              onSideChange={setSide}
              unstaged={unstaged}
              staged={staged}
            />
          )}
        </main>
      </div>

      <MobileSheet open={filesOpen} title="Changed files" onClose={() => setFilesOpen(false)}>
        <ReviewFileList
          files={files}
          activePath={selectedDiffPath}
          isBusy={isGitBusy}
          onSelect={selectFile}
          onRefresh={() => void runGitStatus()}
        />
      </MobileSheet>
    </div>
  );
}
