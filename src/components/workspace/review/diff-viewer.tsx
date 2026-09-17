"use client";

import { Loader2 } from "lucide-react";

import type { ParsedDiff } from "@/components/workspace/review/diff-utils";
import { describeGitStatus } from "@/components/workspace/review/diff-utils";
import { cn } from "@/lib/utils";

export type DiffSide = "unstaged" | "staged";

function DiffRow({
  type,
  text,
  oldNumber,
  newNumber,
}: {
  type: "add" | "del" | "context";
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}) {
  return (
    <div
      className={cn(
        "flex",
        type === "add" && "bg-success/10",
        type === "del" && "bg-danger/10",
        type === "context" && "bg-transparent",
      )}
    >
      <span className="w-10 shrink-0 select-none pr-2 text-right text-[10px] leading-6 text-text-muted">
        {oldNumber ?? ""}
      </span>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-[10px] leading-6 text-text-muted">
        {newNumber ?? ""}
      </span>
      <span
        className={cn(
          "w-5 shrink-0 select-none text-center text-[11px] leading-6",
          type === "add" && "text-success",
          type === "del" && "text-danger",
          type === "context" && "text-text-muted",
        )}
        aria-hidden
      >
        {type === "add" ? "+" : type === "del" ? "-" : ""}
      </span>
      <span className="whitespace-pre pr-6 text-[11px] leading-6 text-text-secondary">{text || " "}</span>
    </div>
  );
}

function SideTab({
  label,
  count,
  active,
  disabled,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-surface-muted text-text-primary"
          : "text-text-muted hover:bg-surface-muted hover:text-text-primary",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-text-muted",
      )}
    >
      {label}
      <span className="rounded-full bg-surface-raised px-1.5 text-[10px] tabular-nums">{count}</span>
    </button>
  );
}

export function DiffViewer({
  path,
  status,
  loading,
  side,
  onSideChange,
  unstaged,
  staged,
}: {
  path: string;
  status?: string;
  loading: boolean;
  side: DiffSide;
  onSideChange: (side: DiffSide) => void;
  unstaged: ParsedDiff;
  staged: ParsedDiff;
}) {
  const descriptor = status ? describeGitStatus(status) : null;
  const active = side === "staged" ? staged : unstaged;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border-strong bg-surface px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {descriptor ? (
            <span
              className={cn(
                "inline-flex h-5 shrink-0 items-center rounded-[5px] bg-surface-raised px-1.5 font-mono text-[10px] font-semibold",
                descriptor.tone,
              )}
            >
              {descriptor.label}
            </span>
          ) : null}
          <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary" title={path}>
            {path || "Select a file"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <SideTab
            label="Unstaged"
            count={unstaged.additions + unstaged.deletions}
            active={side === "unstaged"}
            disabled={unstaged.empty}
            onClick={() => onSideChange("unstaged")}
          />
          <SideTab
            label="Staged"
            count={staged.additions + staged.deletions}
            active={side === "staged"}
            disabled={staged.empty}
            onClick={() => onSideChange("staged")}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums">
          <span className="text-success">+{active.additions}</span>
          <span className="text-danger">-{active.deletions}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-background">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading diff…
          </div>
        ) : !path ? (
          <p className="px-4 py-4 text-xs text-text-muted">Select a file to review its changes.</p>
        ) : active.binary ? (
          <p className="px-4 py-4 text-xs text-text-muted">Binary file — diff not shown.</p>
        ) : active.empty ? (
          <p className="px-4 py-4 text-xs text-text-muted">
            {side === "staged"
              ? "No staged changes for this file."
              : "No unstaged changes for this file. Untracked files show a diff once staged."}
          </p>
        ) : (
          <div className="min-w-max py-1 font-mono">
            {active.hunks.map((hunk, index) => (
              <div key={`${hunk.header}:${index}`}>
                <div className="px-3 py-0.5 text-[10px] leading-6 text-text-muted">{hunk.header}</div>
                {hunk.rows.map((row, rowIndex) => (
                  <DiffRow
                    key={rowIndex}
                    type={row.type}
                    text={row.text}
                    oldNumber={row.oldNumber}
                    newNumber={row.newNumber}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
