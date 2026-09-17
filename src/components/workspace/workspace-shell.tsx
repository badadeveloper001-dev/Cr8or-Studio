"use client";

import { FileText, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { TaskThread } from "@/components/workspace/task/task-thread";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MARKDOWN_CLASS = [
  "h-full overflow-auto px-5 py-4 text-[13px] leading-relaxed text-text-secondary",
  "[&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-text-primary",
  "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-text-primary",
  "[&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-text-primary",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:space-y-1 [&_li]:ml-4 [&_li]:list-disc",
  "[&_a]:text-accent [&_a]:underline",
  "[&_blockquote]:border-l [&_blockquote]:border-border-strong [&_blockquote]:pl-3",
  "[&_code]:rounded [&_code]:bg-surface-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px]",
  "[&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border-strong [&_pre]:bg-surface-muted [&_pre]:p-3",
].join(" ");

function OnboardingDialog() {
  const { isOnboardingOpen, setIsOnboardingOpen, completeOnboarding } = useWorkspaceControllerContext();
  if (!isOnboardingOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Cr8or Studio"
        className="w-full max-w-lg rounded-xl border border-border-strong bg-surface p-5"
      >
        <p className="text-sm font-semibold text-text-primary">Welcome to Cr8or Studio</p>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">
          Complete this setup checklist to make the workspace fully operational.
        </p>
        <ol className="mt-4 space-y-2 text-xs leading-relaxed text-text-secondary">
          <li>1. Configure keys in .env.local for AI, GitHub, and Vercel.</li>
          <li>2. Open Settings and run the Secrets Readiness check.</li>
          <li>3. Select a policy profile: strict, balanced, or autonomous.</li>
          <li>4. Run dry-run previews before the first commit/push and deploy.</li>
          <li>5. Review pending approvals in the Approval Center.</li>
        </ol>
        <div className="mt-5 flex gap-2">
          <Button type="button" size="sm" onClick={completeOnboarding}>
            Complete setup
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setIsOnboardingOpen(false)}>
            Remind me later
          </Button>
        </div>
      </div>
    </div>
  );
}

function DocumentTabs() {
  const { openTabs, activeTabId, setActiveTabId, closeTab } = useWorkspaceControllerContext();
  if (openTabs.length === 0) return null;

  return (
    <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border-strong bg-surface-muted">
      {openTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => setActiveTabId(tab.id)}
          className={cn(
            "flex shrink-0 items-center gap-2 border-r border-border-strong px-3 py-2 text-xs transition-colors",
            activeTabId === tab.id ? "bg-background text-text-primary" : "text-text-muted hover:text-text-secondary",
          )}
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="max-w-40 truncate">{tab.title}</span>
          {tab.dirty ? <span className="text-[9px] text-warning">●</span> : null}
          {openTabs.length > 1 ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Close ${tab.title}`}
              className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <X className="h-3 w-3" />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function DocumentArea() {
  const {
    activeTabId,
    activeDocument,
    isMarkdownDocument,
    activeDocumentLineCount,
    activeLanguage,
    highlightedDocumentHtml,
    loadingFilePath,
    fileErrorByPath,
  } = useWorkspaceControllerContext();

  const error = fileErrorByPath[activeTabId];

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border-strong px-4 py-2">
        <p className="truncate text-[11px] text-text-muted">Document: {activeTabId}</p>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-border-strong px-2 py-0.5 text-[10px] lowercase text-text-muted">
            {activeLanguage}
          </span>
          <span className="text-[10px] text-text-muted">{activeDocumentLineCount} lines</span>
        </div>
      </div>

      {loadingFilePath === activeTabId ? <div className="p-4 text-xs text-text-muted">Loading {activeTabId}...</div> : null}
      {error ? <div className="p-4 text-xs text-danger">{error}</div> : null}

      {!loadingFilePath && !error ? (
        isMarkdownDocument ? (
          <article className={MARKDOWN_CLASS}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {activeDocument || "No content loaded."}
            </ReactMarkdown>
          </article>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="shrink-0 select-none overflow-hidden border-r border-border-strong bg-surface-muted px-2 py-4 text-right font-mono text-[11px] leading-[1.6] text-text-muted">
              {Array.from({ length: activeDocumentLineCount }).map((_, index) => (
                <span key={index} className="block">
                  {index + 1}
                </span>
              ))}
            </div>
            <pre className="min-h-0 flex-1 overflow-auto px-4 py-4 font-mono text-xs leading-[1.6] text-text-primary">
              <code dangerouslySetInnerHTML={{ __html: highlightedDocumentHtml || "No content loaded." }} />
            </pre>
          </div>
        )
      ) : null}
    </section>
  );
}

function CommandPalette() {
  const {
    isPaletteOpen,
    setIsPaletteOpen,
    paletteQuery,
    setPaletteQuery,
    paletteIndex,
    setPaletteIndex,
    paletteInputRef,
    filteredCommands,
    executePaletteCommand,
  } = useWorkspaceControllerContext();

  if (!isPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[11vh]"
      onClick={() => setIsPaletteOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[680px] max-w-[92vw] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border-strong px-3 py-2">
          <input
            ref={paletteInputRef}
            value={paletteQuery}
            onChange={(event) => setPaletteQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setPaletteIndex((prev) => Math.min(prev + 1, Math.max(filteredCommands.length - 1, 0)));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setPaletteIndex((prev) => Math.max(prev - 1, 0));
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const selected = filteredCommands[paletteIndex] ?? filteredCommands[0];
                if (selected) {
                  executePaletteCommand(selected);
                }
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setIsPaletteOpen(false);
              }
            }}
            placeholder="Type a command"
            aria-label="Command palette search"
            className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>
        <div className="max-h-[46vh] overflow-y-auto p-1.5">
          {filteredCommands.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-text-muted">No commands found.</p>
          ) : (
            filteredCommands.map((command, index) => (
              <button
                key={command.id}
                type="button"
                onClick={() => executePaletteCommand(command)}
                className={cn(
                  "block w-full rounded-md px-2 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-surface-muted",
                  index === paletteIndex && "bg-surface-muted",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span>{command.label}</span>
                  {command.hint ? <span className="text-[10px] text-text-muted">{command.hint}</span> : null}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceShell({ onReviewChanges }: { onReviewChanges?: () => void }) {
  const { activeTabId, error } = useWorkspaceControllerContext();

  return (
    <>
      <OnboardingDialog />

      <div className="flex h-full min-h-0 flex-col bg-background">
        <DocumentTabs />

        <div className="flex min-h-0 flex-1 flex-col">
          {activeTabId === "cr8or-ai.chat" ? <TaskThread onReviewChanges={onReviewChanges} /> : <DocumentArea />}
        </div>

        {error ? <p className="shrink-0 border-t border-border-strong px-4 py-2 text-xs text-danger">{error}</p> : null}
      </div>

      <CommandPalette />
    </>
  );
}
