"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Command,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Globe,
  History,
  Home as HomeIcon,
  Loader2,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkspaceSection } from "@/components/workspace/nav-rail";
import { projectIdFor } from "@/lib/workspace/project-ref";

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
  const [previewState, setPreviewState] = useState<"idle" | "starting" | "running" | "failed">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPanelOpen, setPreviewPanelOpen] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const previewProjectId = projectIdFor(currentProject);
  const canPreview = currentProject.runtimeType === "cloud" || previewProjectId.startsWith("cloud-");

  useEffect(() => {
    previewRequest.current?.abort();
    setPreviewState("idle");
    setPreviewUrl(null);
    setPreviewError(null);
    setPreviewPanelOpen(false);
    return () => previewRequest.current?.abort();
  }, [previewProjectId]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!previewPanelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewPanelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewPanelOpen]);

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

  const handlePreview = async () => {
    if (!canPreview) return;
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewState("starting");
    setPreviewPanelOpen(true);
    setPreviewError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(previewProjectId)}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: previewUrl ? "refresh" : "start" }),
        signal: controller.signal,
      });
      const data = await response.json() as { ok?: boolean; url?: string; status?: string; message?: string; error?: { message?: string } };
      if (!response.ok || !data.ok || !data.url) {
        throw new Error(data.message || data.error?.message || "Preview could not start. Please try again.");
      }
      if (controller.signal.aborted) return;
      setPreviewUrl(data.url || null);
      setPreviewState("running");
    } catch (error) {
      if (controller.signal.aborted) return;
      setPreviewState("failed");
      setPreviewError(error instanceof Error ? error.message : "Preview could not start. Please try again.");
    }
  };

  return (
    <>
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-1.5">
        <button type="button" onClick={onHome} aria-label="Cr8or Studio home" className="mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-xs font-semibold text-accent-foreground">C8</button>
        <div className="hidden md:block">
          <IconToggle label="Toggle sidebar" active={secondaryOpen} onClick={onToggleSecondary}>
            <PanelLeft className="h-4 w-4" />
          </IconToggle>
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary" title={currentProject.path}>{currentProject.name}</p>
          <p className="hidden text-[11px] text-text-muted sm:block">{canPreview ? "Cloud workspace" : "Local workspace"}</p>
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
          onClick={() => void handlePreview()}
          disabled={previewState === "starting" || !canPreview}
          title={canPreview ? "Open project preview" : "Select a cloud project to use preview"}
          className="h-9 gap-1.5 rounded-lg"
        >
          {previewState === "starting" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Globe className="h-3.5 w-3.5" />
          )}
          {previewState === "idle" && "Preview"}
          {previewState === "starting" && "Starting…"}
          {previewState === "running" && "Preview ●"}
          {previewState === "failed" && "Preview failed"}
        </Button>
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
    {previewPanelOpen ? (
      <div role="dialog" aria-modal="true" aria-label="Project preview" className="fixed inset-0 z-50 flex flex-col bg-background md:inset-6 md:rounded-2xl md:border md:border-border-strong md:shadow-xl">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-strong bg-surface px-3">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-text-primary">Preview</p>
            <p className="truncate text-[10px] text-text-muted">{currentProject.name}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => void handlePreview()} disabled={previewState === "starting"} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!previewUrl || previewState !== "running"}
              onClick={() => { if (previewUrl) window.open(previewUrl, "_blank", "noopener,noreferrer"); }}
              className="h-7 gap-1 text-[11px]"
            >
              <ExternalLink className="h-3 w-3" />
              Open externally
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Close preview"
              onClick={() => setPreviewPanelOpen(false)}
              className="h-7 w-7 p-0"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {previewState === "starting" ? <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"><Loader2 className="h-7 w-7 animate-spin text-accent" /><p className="text-sm font-medium">Preparing your preview</p><p className="max-w-md text-sm text-text-secondary">Starting the app and checking its connection. The first run may take a little longer.</p></div> : previewState === "failed" ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"><p className="text-lg font-semibold">Preview needs attention</p><p className="max-w-lg text-sm text-text-secondary">{previewError}</p><Button type="button" onClick={() => void handlePreview()}>Try again</Button></div> : previewUrl ? <iframe
          src={previewUrl}
          title="Preview"
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        /> : null}
      </div>
    ) : null}
    </>
  );
}
