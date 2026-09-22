"use client";

import {
  Files,
  FolderGit2,
  GitBranch,
  History,
  Home as HomeIcon,
  ListChecks,
  Settings,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type WorkspaceSection = "tasks" | "projects" | "files" | "source-control" | "history" | "settings";

const SECTIONS: Array<{ id: WorkspaceSection; label: string; Icon: LucideIcon }> = [
  { id: "tasks", label: "Workspace", Icon: ListChecks },
  { id: "projects", label: "Projects", Icon: FolderGit2 },
  { id: "files", label: "Files", Icon: Files },
  { id: "source-control", label: "Changes", Icon: GitBranch },
  { id: "history", label: "History", Icon: History },
  { id: "settings", label: "Settings", Icon: Settings },
];

function RailButton({
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
      title={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "inline-flex h-11 w-full items-center justify-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors lg:justify-start",
        active ? "bg-accent/10 text-accent" : "text-text-secondary hover:bg-surface-muted hover:text-text-primary",
      )}
    >
      {children}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

export function NavRail({
  active,
  onSelect,
  onHome,
}: {
  active: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
  onHome: () => void;
}) {
  return (
    <nav
      aria-label="Primary"
      className="hidden h-full w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface p-2 md:flex lg:w-52 lg:p-4"
    >
      <RailButton label="Home" active={false} onClick={onHome}>
        <HomeIcon className="h-4 w-4" strokeWidth={1.75} />
      </RailButton>
      <span aria-hidden="true" className="my-3 h-px w-full bg-border" />
      {SECTIONS.map(({ id, label, Icon }) => (
        <RailButton key={id} label={label} active={active === id} onClick={() => onSelect(id)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </RailButton>
      ))}
      <div className="mt-auto hidden w-full rounded-xl bg-surface-muted p-3 lg:block">
        <p className="text-xs font-medium text-text-primary">Room to create.</p>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">Your ideas, files, and progress in one place.</p>
      </div>
    </nav>
  );
}
