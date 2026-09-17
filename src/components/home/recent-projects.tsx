"use client";

import { ChevronRight, FolderOpen } from "lucide-react";

export type RecentProject = {
  name: string;
  path: string;
  updatedAt?: string;
};

export function RecentProjects({
  projects,
  onOpen,
}: {
  projects: RecentProject[];
  onOpen: (path: string) => void;
}) {
  return (
    <section aria-labelledby="recent-projects-heading">
      <h2 id="recent-projects-heading" className="text-sm font-semibold tracking-tight text-text-primary">
        Recent projects
      </h2>
      {projects.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No recent projects yet.</p>
      ) : (
        <ul className="mt-3">
          {projects.slice(0, 6).map((project) => (
            <li key={`${project.path}-${project.updatedAt ?? ""}`}>
              <button
                type="button"
                onClick={() => onOpen(project.path)}
                className="group flex min-h-12 w-full items-center gap-3 rounded-md px-2 text-left transition-colors hover:bg-surface-muted"
              >
                <FolderOpen className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">{project.name}</span>
                  <span className="block truncate text-xs text-text-muted">{project.path}</span>
                </span>
                {project.updatedAt ? (
                  <span className="hidden shrink-0 text-xs text-text-muted sm:block">
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </span>
                ) : null}
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
