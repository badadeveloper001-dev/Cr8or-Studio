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
  { id: "tasks", label: "Tasks", Icon: ListChecks },
  { id: "projects", label: "Projects", Icon: FolderGit2 },
  { id: "files", label: "Files", Icon: Files },
  { id: "source-control", label: "Source Control", Icon: GitBranch },
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
        "inline-flex h-11 w-11 items-center justify-center rounded-lg transition-colors",
        active ? "bg-surface-raised text-text-primary" : "text-text-muted hover:bg-surface hover:text-text-primary",
      )}
    >
      {children}
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
      className="hidden h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-border-strong bg-surface-muted py-2 md:flex"
    >
      <RailButton label="Home" active={false} onClick={onHome}>
        <HomeIcon className="h-4 w-4" strokeWidth={1.75} />
      </RailButton>
      <span aria-hidden="true" className="my-1 h-px w-7 bg-border-strong" />
      {SECTIONS.map(({ id, label, Icon }) => (
        <RailButton key={id} label={label} active={active === id} onClick={() => onSelect(id)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </RailButton>
      ))}
    </nav>
  );
}
