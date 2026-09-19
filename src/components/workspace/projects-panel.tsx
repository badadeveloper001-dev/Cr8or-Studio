"use client";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { Button } from "@/components/ui/button";

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-border-strong bg-surface px-2.5 text-xs text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent";

function Row({
  label,
  placeholder,
  value,
  onChange,
  actionLabel,
  busyLabel,
  isBusy,
  onAction,
  disabled,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  actionLabel: string;
  busyLabel: string;
  isBusy: boolean;
  onAction: () => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium text-text-secondary">{label}</p>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={INPUT_CLASS}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={onAction}
        disabled={isBusy || disabled}
      >
        {isBusy ? busyLabel : actionLabel}
      </Button>
    </div>
  );
}

export function ProjectsPanel() {
  const {
    currentProject,
    recentProjects,
    projectNameInput,
    setProjectNameInput,
    projectPathInput,
    setProjectPathInput,
    repositoryInput,
    setRepositoryInput,
    createProject,
    openProjectByPath,
    cloneGithubProject,
    isProjectBusy,
    projectError,
  } = useWorkspaceControllerContext();

  return (
    <div className="space-y-5 p-3">
      {projectError ? <p role="alert" className="text-xs text-danger">{projectError}</p> : null}
      <div className="rounded-md border border-border-strong bg-surface-muted px-3 py-2">
        <p className="text-[11px] text-text-muted">Active project</p>
        <p className="mt-0.5 truncate text-xs text-text-primary">{currentProject.name}</p>
        <p className="truncate text-[11px] text-text-muted">{currentProject.path}</p>
      </div>

      <Row
        label="New project"
        placeholder="Project name"
        value={projectNameInput}
        onChange={setProjectNameInput}
        actionLabel="Create project"
        busyLabel="Creating..."
        isBusy={isProjectBusy}
        onAction={() => void createProject()}
        disabled={!projectNameInput.trim()}
      />

      <Row
        label="Open project"
        placeholder="projects/my-app"
        value={projectPathInput}
        onChange={setProjectPathInput}
        actionLabel="Open project"
        busyLabel="Opening..."
        isBusy={isProjectBusy}
        onAction={() => void openProjectByPath(projectPathInput)}
        disabled={!projectPathInput.trim()}
      />

      <Row
        label="Clone repository"
        placeholder="https://github.com/org/repo.git"
        value={repositoryInput}
        onChange={setRepositoryInput}
        actionLabel="Clone repository"
        busyLabel="Cloning..."
        isBusy={isProjectBusy}
        onAction={() => void cloneGithubProject()}
        disabled={!repositoryInput.trim()}
      />

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Recent</p>
        {recentProjects.length === 0 ? (
          <p className="py-2 text-xs text-text-muted">No recent projects yet.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border-strong">
            {recentProjects.map((project) => (
              <li key={`${project.path}-${project.updatedAt ?? ""}`}>
                <button
                  type="button"
                  onClick={() => void openProjectByPath(project.path)}
                  className="w-full py-2 text-left transition-colors hover:bg-surface-muted"
                >
                  <span className="block truncate text-xs text-text-primary">{project.name}</span>
                  <span className="block truncate text-[11px] text-text-muted">{project.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
