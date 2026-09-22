"use client";

import { useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, ImagePlus, Loader2, Sparkles, StopCircle, X } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { Button } from "@/components/ui/button";
import { AgentActivity } from "@/components/workspace/task/agent-activity";
import { ChangedFilesSummary } from "@/components/workspace/task/changed-files-summary";
import { InlineApproval } from "@/components/workspace/task/inline-approval";
import { TaskMessage } from "@/components/workspace/task/task-message";



function TaskComposer() {
  const {
    chatInput,
    setChatInput,
    chatAttachments,
    setChatAttachments,
    chatMessages,
    setChatMessages,
    chatInputRef,
    chatFileInputRef,
    isChatting,
    isRunning,
    sendChat,
    handleChatAttachmentSelection,
    prompt,
    runOrchestration,
  } = useWorkspaceControllerContext();

  const canSend = !isChatting && !isRunning && (chatInput.trim().length > 0 || chatAttachments.length > 0);
  const canClear = !isChatting && !isRunning && (chatMessages.length > 1 || chatAttachments.length > 0);

  return (
    <div className="shrink-0 bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto w-full max-w-4xl px-4 pb-5 pt-3 sm:px-8">
        <input
          ref={chatFileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void handleChatAttachmentSelection(event.target.files);
            event.currentTarget.value = "";
          }}
        />
        {chatAttachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {chatAttachments.map((attachment) => (
              <span
                key={`${attachment.name}-${attachment.sizeBytes}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-strong bg-surface-muted px-2.5 py-1 text-[11px] text-text-secondary"
              >
                <span className="truncate">{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  className="text-text-muted transition-colors hover:text-text-primary"
                  onClick={() => setChatAttachments((prev) => prev.filter((item) => item !== attachment))}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="rounded-2xl border border-border-strong bg-surface px-4 py-3 shadow-[0_6px_24px_-12px_rgba(20,50,45,0.15)] transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10">
          <textarea
            ref={chatInputRef}
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void sendChat();
              }
            }}
            rows={2}
            aria-label="Message Cr8or"
            placeholder="Tell Cr8or what to build, fix, or understand..."
            className="block w-full resize-none bg-transparent px-0.5 py-1 text-[13px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border-strong pt-2">
            <div className="flex flex-wrap items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => chatFileInputRef.current?.click()}
                disabled={isChatting || isRunning || chatAttachments.length >= 3}
                className="gap-1.5"
              >
                <ImagePlus className="h-3.5 w-3.5" />
                Images
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setChatMessages((prev) => prev.slice(0, 1));
                  setChatAttachments([]);
                }}
                disabled={!canClear}
              >
                Clear
              </Button>

            </div>
            <div className="flex items-center gap-1.5">
              {isRunning ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void runOrchestration(prompt, "manual")}
                  className="gap-1.5"
                >
                  <StopCircle className="h-3.5 w-3.5" />
                  Stop
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={() => void sendChat()} disabled={!canSend} className="gap-1.5">
                {isChatting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
                Send
              </Button>
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-text-muted">Review the results. Keep what works. Make it yours.</p>
      </div>
    </div>
  );
}

function CollapsedActivity({
  timeline,
  executionReceipts,
  runHistory,
}: {
  timeline: import("@/lib/agents/types").AgentTask[];
  executionReceipts: import("@/hooks/use-workspace-controller").ExecutionReceipt[];
  runHistory: import("@/hooks/use-workspace-controller").RunHistoryItem[];
}) {
  const [expanded, setExpanded] = useState(false);

  const agentCount = new Set(timeline.map((t) => t.agentId)).size;
  const actionCount = executionReceipts.length;
  const hasActivity = agentCount > 0 || actionCount > 0 || runHistory.length > 0;

  if (!hasActivity) return null;

  return (
    <div className="rounded-lg border border-border-strong bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-surface-muted"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="font-medium text-text-primary">
          Activity
          {agentCount > 0 ? ` · ${agentCount} agent${agentCount !== 1 ? "s" : ""}` : ""}
          {actionCount > 0 ? ` · ${actionCount} action${actionCount !== 1 ? "s" : ""}` : ""}
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border-strong px-3 py-2">
          <AgentActivity />
        </div>
      ) : null}
    </div>
  );
}

export function TaskThread({ onReviewChanges }: { onReviewChanges?: () => void }) {
  const {
    chatMessages,
    isChatting,
    isRunning,
    chatScrollRef,
    sendChat,
    pendingDelegation,
    pendingPromptDraft,
    setPendingPromptDraft,
    approveDelegation,
    cancelDelegation,
    approvals,
    isApprovalsBusy,
    decideApproval,
    runHistory,
    executionReceipts,
    statusLine,
    error,
    timeline,
  } = useWorkspaceControllerContext();

  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");

  const hasUserMessage = chatMessages.some((message) => message.role === "user");
  const showEmptyState =
    !hasUserMessage && !isRunning && !isChatting && timeline.length === 0 && runHistory.length === 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
          {showEmptyState ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center sm:py-20">
              <span className="mb-2 flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/15 bg-accent/10 text-accent"><Sparkles className="h-6 w-6" /></span>
              <h1 className="text-3xl font-semibold tracking-tight text-text-primary">Let’s make something great.</h1>
              <p className="max-w-md text-sm leading-relaxed text-text-secondary">
                Describe a feature, explore your code, or tackle a bug. Your workspace is ready for the next idea.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {["Inspect the project structure", "Explain how this app works"].map((suggestion) => <button key={suggestion} type="button" onClick={() => void sendChat(suggestion)} className="rounded-xl border border-border-strong bg-surface px-4 py-3 text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-accent">{suggestion}</button>)}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {chatMessages.map((message) => (
                <TaskMessage
                  key={message.id}
                  role={message.role}
                  content={message.content}
                  suggestions={message.suggestions}
                  onSuggestion={(suggestion) => void sendChat(suggestion)}
                  disabled={isChatting || isRunning}
                />
              ))}
              {isChatting ? <p className="text-xs text-text-muted">Cr8or is thinking...</p> : null}
            </div>
          )}

          {isRunning ? <div className="space-y-3 rounded-2xl border border-accent/20 bg-surface p-4">
            <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-accent"><Loader2 className="h-4 w-4 shrink-0 animate-spin" /><span>{statusLine || "Working on your request…"}</span></div>
            <AgentActivity />
          </div> : null}

          {pendingDelegation ? (
            <InlineApproval
              title="Cr8or wants to delegate this task"
              meta={["Delegation plan"]}
              busy={isRunning}
              approveLabel="Approve and run"
              rejectLabel="Cancel"
              onApprove={approveDelegation}
              onReject={cancelDelegation}
            >
              <textarea
                value={pendingPromptDraft}
                onChange={(event) => setPendingPromptDraft(event.target.value)}
                rows={3}
                aria-label="Delegation prompt"
                className="mt-2 w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-2 text-xs text-text-primary outline-none focus:border-accent"
              />
            </InlineApproval>
          ) : null}

          {pendingApprovals.map((approval) => (
            <InlineApproval
              key={approval.id}
              title={approval.title}
              actionLabel={approval.action}
              details={approval.preview}
              meta={[approval.requestedBy, approval.requestedRole, approval.requestedAt]}
              busy={isApprovalsBusy}
              onApprove={() => void decideApproval(approval, "approved")}
              onReject={() => void decideApproval(approval, "denied")}
            />
          ))}

          <ChangedFilesSummary onReviewChanges={onReviewChanges} />

          <CollapsedActivity
            timeline={timeline}
            executionReceipts={executionReceipts}
            runHistory={runHistory}
          />

          {statusLine && !isRunning ? (
            <p className="text-center text-[11px] text-text-muted">{statusLine}</p>
          ) : null}

          {error ? (
            <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>
          ) : null}
        </div>
      </div>

      <TaskComposer />
    </section>
  );
}
