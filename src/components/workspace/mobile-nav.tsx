"use client";

import { GitBranch, Home as HomeIcon, Menu, PanelsTopLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import type { WorkspaceSection } from "@/components/workspace/nav-rail";

export function MobileNav({
  active,
  onHome,
  onWorkspace,
  onChanges,
  onMore,
}: {
  active: WorkspaceSection;
  onHome: () => void;
  onWorkspace: () => void;
  onChanges: () => void;
  onMore: () => void;
}) {
  const items = [
    { id: "home", label: "Home", Icon: HomeIcon, onSelect: onHome, isActive: false },
    { id: "workspace", label: "Workspace", Icon: PanelsTopLeft, onSelect: onWorkspace, isActive: active === "tasks" },
    {
      id: "changes",
      label: "Changes",
      Icon: GitBranch,
      onSelect: onChanges,
      isActive: active === "source-control",
    },
    { id: "more", label: "More", Icon: Menu, onSelect: onMore, isActive: false },
  ];

  return (
    <nav
      aria-label="Mobile"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-border-strong bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {items.map(({ id, label, Icon, onSelect, isActive }) => (
        <button
          key={id}
          type="button"
          aria-current={isActive ? "page" : undefined}
          onClick={onSelect}
          className={cn(
            "flex h-14 flex-col items-center justify-center gap-1 text-[11px] transition-colors",
            isActive ? "text-accent" : "text-text-muted hover:text-text-primary",
          )}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} />
          {label}
        </button>
      ))}
    </nav>
  );
}
