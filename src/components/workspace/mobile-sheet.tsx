"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

export type MobileSheetId =
  | "projects"
  | "files"
  | "source-control"
  | "agents"
  | "run"
  | "approvals"
  | "deployments"
  | "history"
  | "settings";

export function MobileSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:hidden">
      <button
        type="button"
        aria-label="Close sheet"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 max-h-[82dvh] w-full overflow-y-auto overflow-x-hidden overscroll-contain rounded-t-2xl border-t border-border-strong bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-border-strong bg-surface py-1.5 pl-4 pr-1.5">
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          <button
            type="button"
            aria-label="Close"
            autoFocus
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  );
}
