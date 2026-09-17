"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  Command,
  FolderGit2,
  GitBranch,
  History,
  Home as HomeIcon,
  PanelLeft,
  PanelRight,
  Settings,
  SquareTerminal,
} from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkspaceSection } from "@/components/workspace/nav-rail";

function IconToggle({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors",
        active ? "bg-surface-muted text-text-primary" : "text-text-muted hover:bg-surface-muted hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}

export function WorkspaceTopBar({
  section,
  onSelectSection,
  onHome,
  secondaryOpen,
  onToggleSecondary,
  rightOpen,
  onToggleRight,
  onOpenReview,
}: {
  section: WorkspaceSection;
  onSelectSection: (section: WorkspaceSection) => void;
  onHome: () => void;
  secondaryOpen: boolean;
  onToggleSecondary: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
  onOpenReview: () => void;
}) {
  const {
    currentProject,
    gitSnapshot,
    isRunning,
    running,
    completed,
    statusLine,
    setIsPaletteOpen,
    showBottomPanel,
    setShowBottomPanel,
  } = useWorkspaceControllerContext();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const statusText = isRunning
    ? `${running} running${completed > 0 ? ` · ${completed} done` : ""}`
    : statusLine || "Ready";

  const menuItems: Array<{ label: string; Icon: typeof FolderGit2; id: WorkspaceSection | "home"; onSelect: () => void }> = [
    { label: "Projects", Icon: FolderGit2, id: "projects", onSelect: () => onSelectSection("projects") },
    { label: "Source control", Icon: GitBranch, id: "source-control", onSelect: () => onSelectSection("source-control") },
    { label: "History", Icon: History, id: "history", onSelect: () => onSelectSection("history") },
    { label: "Settings", Icon: Settings, id: "settings", onSelect: () => onSelectSection("settings") },
    { label: "Home", Icon: HomeIcon, id: "home", onSelect: onHome },
  ];

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border-strong bg-surface px-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="hidden md:block">
          <IconToggle label="Toggle sidebar" active={secondaryOpen} onClick={onToggleSecondary}>
            <PanelLeft className="h-4 w-4" />
          </IconToggle>
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-text-primary">{currentProject.name}</p>
          <p className="hidden truncate text-[10px] text-text-muted sm:block">{currentProject.path}</p>
        </div>
        {gitSnapshot?.branch ? (
          <span className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-md border border-border-strong px-1.5 py-0.5 text-[10px] text-text-secondary">
            <GitBranch className="h-3 w-3" />
            {gitSnapshot.branch}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn("hidden max-w-48 truncate text-[11px] sm:block", isRunning ? "text-accent" : "text-text-muted")}>
          {statusText}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenReview}
          className="hidden h-8 gap-1.5 rounded-md sm:inline-flex"
        >
          <GitBranch className="h-3.5 w-3.5" />
          Review changes
        </Button>
        <ThemeToggle />
        <IconToggle
          label="Toggle terminal"
          active={showBottomPanel}
          onClick={() => setShowBottomPanel((prev) => !prev)}
        >
          <SquareTerminal className="h-4 w-4" />
        </IconToggle>
        <div className="relative">
          <IconToggle label="Project menu" active={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <ChevronDown className="h-4 w-4" />
          </IconToggle>
          {menuOpen ? (
            <>
              <button
                type="button"
                aria-label="Close project menu"
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-40 cursor-default"
              />
              <div
                role="menu"
                aria-label="Project menu"
                className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-border-strong bg-surface py-1 shadow-sm"
              >
                {menuItems.map(({ label, Icon, id, onSelect }) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelect();
                      setMenuOpen(false);
                    }}
                    className={cn(
                      "flex h-10 w-full items-center gap-2.5 px-3 text-left text-xs text-text-primary transition-colors hover:bg-surface-muted",
                      section === id && "bg-surface-muted",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 text-text-muted" />
                    {label}
                  </button>
                ))}
                <div className="my-1 h-px bg-border-strong" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsPaletteOpen(true);
                    setMenuOpen(false);
                  }}
                  className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-xs text-text-primary transition-colors hover:bg-surface-muted"
                >
                  <Command className="h-3.5 w-3.5 text-text-muted" />
                  Command palette
                </button>
              </div>
            </>
          ) : null}
        </div>
        <div className="hidden lg:block">
          <IconToggle label="Toggle context panel" active={rightOpen} onClick={onToggleRight}>
            <PanelRight className="h-4 w-4" />
          </IconToggle>
        </div>
      </div>
    </header>
  );
}
