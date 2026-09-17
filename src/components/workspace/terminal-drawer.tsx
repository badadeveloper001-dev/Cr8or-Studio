"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronsDown, X } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MIN_HEIGHT = 180;
const DEFAULT_HEIGHT = 300;
const MAX_HEIGHT = 560;

function maxHeight() {
  if (typeof window === "undefined") return MAX_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(window.innerHeight * 0.7)));
}

function TerminalBody({ trailing }: { trailing?: React.ReactNode }) {
  const {
    activeBottomTab,
    setActiveBottomTab,
    terminalEntries,
    visibleTerminalEntries,
    hiddenTerminalEntriesCount,
    terminalCommand,
    setTerminalCommand,
    runTerminalCommand,
    error,
    executionReceipts,
    visibleReceipts,
    hiddenReceiptCount,
    timeline,
    visibleOutputTimeline,
    hiddenOutputTimelineCount,
    runHistory,
    synthesis,
    isRunning,
    running,
    completed,
    chatMessages,
    leadInsights,
  } = useWorkspaceControllerContext();

  const tabs: Array<{ id: "terminal" | "problems" | "output" | "debug"; label: string }> = [
    { id: "terminal", label: "Terminal" },
    { id: "problems", label: "Problems" },
    { id: "output", label: "Output" },
    { id: "debug", label: "Debug" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border-strong pl-1 pr-1">
        <div role="tablist" aria-label="Panel sections" className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeBottomTab === tab.id}
              onClick={() => setActiveBottomTab(tab.id)}
              className={cn(
                "h-9 shrink-0 px-2.5 text-[11px] transition-colors",
                activeBottomTab === tab.id
                  ? "text-text-primary"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {trailing}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {activeBottomTab === "terminal" ? (
          <div className="space-y-2">
            {hiddenTerminalEntriesCount > 0 ? (
              <p className="text-[10px] text-text-muted">
                Showing latest {visibleTerminalEntries.length} of {terminalEntries.length}.
              </p>
            ) : null}
            <pre className="max-h-24 min-h-[4.5rem] overflow-auto rounded-md border border-border-strong bg-surface-muted p-2 font-mono text-[11px] leading-relaxed text-text-secondary">
              {visibleTerminalEntries.map((entry) => entry.text).join("\n")}
            </pre>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={terminalCommand}
                onChange={(event) => setTerminalCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") runTerminalCommand();
                }}
                placeholder="run | stop | status | clear | chat <message>"
                aria-label="Terminal command"
                className="h-8 w-full rounded-md border border-border-strong bg-surface px-2.5 text-[11px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
              />
              <Button type="button" size="sm" variant="outline" onClick={runTerminalCommand}>
                Execute
              </Button>
            </div>
          </div>
        ) : null}

        {activeBottomTab === "problems" ? (
          <p className="text-[11px] leading-relaxed text-text-secondary">
            {error ? <span className="text-danger">1 error: {error}</span> : "No problems have been detected."}
          </p>
        ) : null}

        {activeBottomTab === "output" ? (
          <div className="space-y-2 text-[11px] text-text-secondary">
            <div className="rounded-md border border-border-strong p-2">
              <p className="text-text-secondary">Execution receipts</p>
              {hiddenReceiptCount > 0 ? (
                <p className="text-[10px] text-text-muted">
                  Showing latest {visibleReceipts.length} of {executionReceipts.length}.
                </p>
              ) : null}
              {visibleReceipts.length === 0 ? (
                <p className="mt-1 text-text-muted">No receipts yet.</p>
              ) : (
                <div className="mt-1 space-y-1.5">
                  {visibleReceipts.map((receipt) => (
                    <div key={receipt.id} className="rounded-md border border-border-strong bg-surface-muted px-2 py-1.5">
                      <p className="text-text-primary">
                        [{receipt.status.toUpperCase()}] {receipt.title}
                      </p>
                      <p className="text-[10px] text-text-muted">{new Date(receipt.createdAt).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {hiddenOutputTimelineCount > 0 ? (
              <p className="text-[10px] text-text-muted">
                Showing latest {visibleOutputTimeline.length} of {timeline.length}.
              </p>
            ) : null}
            {timeline.length === 0 ? (
              <p>No output yet.</p>
            ) : (
              visibleOutputTimeline.map((task) => (
                <p key={task.id}>
                  [{task.agentId}] {task.status}
                </p>
              ))
            )}
            {runHistory[0] ? (
              <p className="pt-1 text-text-muted">
                Last run: {runHistory[0].status} · {Math.round(runHistory[0].durationMs / 100) / 10}s · $
                {runHistory[0].estimatedCostUsd.toFixed(4)}
              </p>
            ) : null}
            {synthesis ? (
              <p className="pt-1 text-text-muted">
                Synthesis ready: requirements {synthesis.requirements.length}, architecture{" "}
                {synthesis.architecture.length}, quality {synthesis.quality.length}
              </p>
            ) : null}
          </div>
        ) : null}

        {activeBottomTab === "debug" ? (
          <pre className="font-mono text-[11px] text-text-secondary">
            {JSON.stringify(
              {
                running,
                completed,
                isRunning,
                chatMessages: chatMessages.length,
                terminalEntries: terminalEntries.length,
                runHistory: runHistory.length,
                executionReceipts: executionReceipts.length,
                leadInsights,
              },
              null,
              2,
            )}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

export function TerminalDrawer() {
  const { showBottomPanel, setShowBottomPanel } = useWorkspaceControllerContext();
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (!showBottomPanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowBottomPanel(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showBottomPanel, setShowBottomPanel]);

  if (!showBottomPanel) return null;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: event.clientY, startHeight: height };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = drag.current.startHeight + (drag.current.startY - event.clientY);
    setHeight(Math.max(MIN_HEIGHT, Math.min(next, maxHeight())));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <>
      <div
        className="hidden shrink-0 flex-col border-t border-border-strong bg-surface md:flex"
        style={{ height }}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center"
        >
          <span
            className={cn(
              "h-0.5 w-10 rounded-full transition-colors",
              dragging ? "bg-accent" : "bg-border-strong group-hover:bg-text-muted",
            )}
          />
        </div>
        <TerminalBody
          trailing={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setShowBottomPanel(false)}
              aria-label="Collapse terminal"
              className="h-8 shrink-0 px-2"
            >
              <ChevronsDown className="h-4 w-4" />
            </Button>
          }
        />
      </div>

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Terminal"
        className="fixed inset-0 z-50 flex flex-col bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <TerminalBody
          trailing={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              autoFocus
              onClick={() => setShowBottomPanel(false)}
              aria-label="Close terminal"
              className="h-8 shrink-0 px-2"
            >
              <X className="h-4 w-4" />
            </Button>
          }
        />
      </div>
    </>
  );
}
