"use client";

import { useMemo } from "react";
import { ImagePlus, Loader2, Play, Send, StopCircle, X } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { Button } from "@/components/ui/button";
import { CommandActivity } from "@/components/workspace/command-activity";
import { AgentActivity } from "@/components/workspace/task/agent-activity";
import { ChangedFilesSummary } from "@/components/workspace/task/changed-files-summary";
import { InlineApproval } from "@/components/workspace/task/inline-approval";
import { RunResult } from "@/components/workspace/task/run-result";
import { TaskMessage } from "@/components/workspace/task/task-message";
import { TaskStatus } from "@/components/workspace/task/task-status";
import { buildRunResults, mapTaskStatus } from "@/components/workspace/task/task-utils";

import type { DelegationPolicy } from "@/hooks/use-workspace-controller";

const POLICY_OPTIONS: Array<{ value: DelegationPolicy; label: string }> = [
  { value: "auto", label: "Auto delegate" },
  { value: "ask", label: "Ask before run" },
  { value: "chat-only", label: "Chat only" },
];

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
    delegationPolicy,
    setDelegationPolicy,
    prompt,
    runOrchestration,
  } = useWorkspaceControllerContext();

  const canSend = !isChatting && !isRunning && (chatInput.trim().length > 0 || chatAttachments.length > 0);
  const canClear = !isChatting && (chatMessages.length > 1 || chatAttachments.length > 0);

  return (
    <div className="shrink-0 border-t border-border-strong bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto w-full max-w-3xl px-3 py-3 sm:px-6">
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
        <div className="rounded-xl border border-border-strong bg-surface px-3 py-2.5 transition-colors focus-within:border-accent">
          <textarea
            ref={chatInputRef}
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendChat();
              }
            }}
            rows={2}
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
              <label htmlFor="task-thread-policy" className="sr-only">
                Delegation policy
              </label>
              <select
                id="task-thread-policy"
                value={delegationPolicy}
                onChange={(event) => setDelegationPolicy(event.target.value as DelegationPolicy)}
                className="h-7 rounded-md border border-border-strong bg-surface px-1.5 text-[11px] text-text-secondary outline-none transition-colors focus:border-accent"
              >
                {POLICY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
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
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void runOrchestration(chatInput.trim() || prompt, "manual")}
                  className="gap-1.5"
                >
                  <Play className="h-3.5 w-3.5" />
                  Delegate
                </Button>
              )}
              <Button type="button" size="sm" onClick={() => void sendChat()} disabled={!canSend} className="gap-1.5">
                {isChatting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
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
    synthesis,
    statusLine,
    error,
    gitSnapshot,
    timeline,
  } = useWorkspaceControllerContext();

  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");

  const taskStatus = mapTaskStatus({
    isRunning,
    isChatting,
    hasPendingApproval: Boolean(pendingDelegation) || pendingApprovals.length > 0,
    hasError: Boolean(error),
    latestRunStatus: runHistory[0]?.status,
    changedCount: gitSnapshot?.changedCount ?? 0,
  });

  const runResults = useMemo(
    () => buildRunResults({ runHistory, receipts: executionReceipts, synthesis }),
    [runHistory, executionReceipts, synthesis],
  );

  const hasUserMessage = chatMessages.some((message) => message.role === "user");
  const showEmptyState =
    !hasUserMessage && !isRunning && !isChatting && timeline.length === 0 && runHistory.length === 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6 sm:py-7">
          <div className="flex items-center justify-between gap-3">
            <TaskStatus status={taskStatus} />
            <p className="min-w-0 truncate text-right text-[11px] text-text-muted">{statusLine}</p>
          </div>

          {showEmptyState ? (
            <div className="flex flex-col items-center gap-2 py-14 text-center sm:py-20">
              <p className="text-sm text-text-secondary">Tell Cr8or what you want to build, fix, or understand.</p>
              <p className="max-w-sm text-xs leading-relaxed text-text-muted">
                Execution requests are delegated to specialist agents. Questions stay conversational.
              </p>
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

          <AgentActivity />

          <CommandActivity />

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

          {runResults.length > 0 ? (
            <div className="flex flex-col gap-2">
              {runResults.map((result) => (
                <RunResult key={result.id} result={result} />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <TaskComposer />
    </section>
  );
}
