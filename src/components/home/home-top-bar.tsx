"use client";

import { PanelsTopLeft, Settings2 } from "lucide-react";

import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";

export function HomeTopBar({
  onOpenSettings,
  onEnterWorkspace,
  showWorkspace,
}: {
  onOpenSettings: () => void;
  onEnterWorkspace: () => void;
  showWorkspace: boolean;
}) {
  return (
    <header className="flex h-20 items-center justify-between gap-3 border-b border-border bg-surface px-5 sm:px-10">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-sm font-semibold tracking-tight text-accent-foreground"
        >
          C8
        </span>
        <span className="text-base font-semibold tracking-tight text-text-primary">Cr8or <span className="font-normal text-text-muted">Studio</span></span>
      </div>
      <div className="flex items-center gap-2">
        {showWorkspace ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEnterWorkspace}
            className="h-10 gap-2 rounded-md px-3 text-text-secondary hover:text-text-primary"
          >
            <PanelsTopLeft className="h-4 w-4" />
            Workspace
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Settings and profile"
          title="Settings and profile"
          onClick={onOpenSettings}
          className="size-10 text-text-muted hover:text-text-primary"
        >
          <Settings2 className="h-4 w-4" />
        </Button>
        <ThemeToggle />
      </div>
    </header>
  );
}
