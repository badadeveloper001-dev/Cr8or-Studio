"use client";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { HomeComposer } from "@/components/home/home-composer";
import { HomeTopBar } from "@/components/home/home-top-bar";
import { ProjectActions } from "@/components/home/project-actions";
import { RecentProjects } from "@/components/home/recent-projects";
import { RecentTasks } from "@/components/home/recent-tasks";

export function HomeView({
  onEnterWorkspace,
  onOpenSettings,
}: {
  onEnterWorkspace: () => void;
  onOpenSettings: () => void;
}) {
  const {
    prompt,
    isRunning,
    recentProjects,
    runHistory,
    isProjectBusy,
    currentProject,
    createProject,
    openProjectByPath,
    cloneGithubProject,
    runOrchestration,
  } = useWorkspaceControllerContext();

  const handleRun = (nextPrompt: string) => {
    void runOrchestration(nextPrompt, "manual");
    onEnterWorkspace();
  };

  return (
    <div className="min-h-dvh w-full overflow-x-hidden bg-background text-text-primary">
      <HomeTopBar
        onOpenSettings={onOpenSettings}
        onEnterWorkspace={onEnterWorkspace}
        showWorkspace={currentProject.path !== "."}
      />
      <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-8 sm:px-8 sm:pt-14">
        <section aria-labelledby="home-heading">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">Cr8or Studio</p>
          <h1 id="home-heading" className="mt-3 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            What are you working on?
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-secondary">
            Describe a task and Cr8or AI will plan, delegate, and execute it with specialist agents.
          </p>
          <div className="mt-6">
            <HomeComposer initialPrompt={prompt} isRunning={isRunning} onSubmit={handleRun} />
          </div>
        </section>

        <section aria-labelledby="project-actions-heading" className="mt-14">
          <h2 id="project-actions-heading" className="text-sm font-semibold tracking-tight text-text-primary">
            Start from
          </h2>
          <div className="mt-3">
            <ProjectActions
              isBusy={isProjectBusy}
              onCreate={(name) => {
                void createProject(name);
                onEnterWorkspace();
              }}
              onOpen={(path) => {
                void openProjectByPath(path);
                onEnterWorkspace();
              }}
              onClone={async (repositoryUrl) => {
                await cloneGithubProject(repositoryUrl);
                onEnterWorkspace();
              }}
            />
          </div>
        </section>

        <div className="mt-14">
          <RecentProjects
            projects={recentProjects}
            onOpen={(path) => {
              void openProjectByPath(path);
              onEnterWorkspace();
            }}
          />
        </div>

        <div className="mt-14">
          <RecentTasks tasks={runHistory} />
        </div>
      </main>
    </div>
  );
}
