"use client";

import { X } from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { FilesPanel } from "@/components/workspace/files-panel";
import { HistoryPanel } from "@/components/workspace/history-panel";
import { ProjectsPanel } from "@/components/workspace/projects-panel";
import { SettingsPanel } from "@/components/workspace/settings-panel";
import { SourceControlPanel } from "@/components/workspace/source-control-panel";
import type { WorkspaceSection } from "@/components/workspace/nav-rail";
import { cn } from "@/lib/utils";

const SECTION_TITLES: Record<WorkspaceSection, string> = {
  tasks: "Tasks",
  projects: "Projects",
  files: "Files",
  "source-control": "Source Control",
  history: "History",
  settings: "Settings",
};

const TASK_STATUS_STYLES: Record<string, string> = {
  completed: "text-success",
  running: "text-accent",
  failed: "text-danger",
  blocked: "text-warning",
  pending: "text-text-muted",
  idle: "text-text-muted",
};

function TasksPanel() {
  const { timeline, statusLine, isRunning } = useWorkspaceControllerContext();

  if (timeline.length === 0) {
    return (
      <p className="px-3 py-3 text-xs leading-relaxed text-text-muted">
        {isRunning ? "Planning work packages..." : "No active run. Start a task from the composer."}
      </p>
    );
  }

  return (
    <div>
      <p className="border-b border-border-strong px-3 py-2 text-[11px] text-text-muted">{statusLine}</p>
      <ul className="divide-y divide-border-strong">
        {timeline.map((task) => (
          <li key={task.id} className="px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 text-xs leading-snug text-text-primary">{task.title}</p>
              <span className={cn("shrink-0 text-[10px] capitalize", TASK_STATUS_STYLES[task.status] ?? "text-text-muted")}>
                {task.status}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-text-muted">{task.agentId}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SecondarySidebarContent({
  section,
  onOpenReview,
}: {
  section: WorkspaceSection;
  onOpenReview?: (path?: string) => void;
}) {
  if (section === "tasks") return <TasksPanel />;
  if (section === "projects") return <ProjectsPanel />;
  if (section === "files") return <FilesPanel />;
  if (section === "source-control") return <SourceControlPanel onOpenReview={onOpenReview} />;
  if (section === "history") return <HistoryPanel />;
  return <SettingsPanel />;
}

export function SecondarySidebar({
  section,
  onClose,
  onOpenReview,
}: {
  section: WorkspaceSection;
  onClose: () => void;
  onOpenReview?: (path?: string) => void;
}) {
  return (
    <aside
      aria-label={SECTION_TITLES[section]}
      className="hidden h-full w-72 shrink-0 flex-col border-r border-border-strong bg-surface md:flex xl:w-80"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-strong pl-3 pr-1">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">{SECTION_TITLES[section]}</p>
        <button
          type="button"
          aria-label={`Hide ${SECTION_TITLES[section]} sidebar`}
          onClick={onClose}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <SecondarySidebarContent section={section} onOpenReview={onOpenReview} />
      </div>
    </aside>
  );
}
