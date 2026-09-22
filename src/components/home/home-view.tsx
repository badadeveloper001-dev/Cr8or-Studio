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
    sendChat,
    projectError,
    isChatting,
  } = useWorkspaceControllerContext();

  const handleRun = (nextPrompt: string) => {
    void sendChat(nextPrompt);
    onEnterWorkspace();
  };

  return (
    <div className="min-h-dvh w-full overflow-x-hidden bg-background text-text-primary">
      <HomeTopBar
        onOpenSettings={onOpenSettings}
        onEnterWorkspace={onEnterWorkspace}
        showWorkspace={currentProject.path !== "."}
      />
      <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-12 sm:px-10 sm:pt-20">
        <section aria-labelledby="home-heading" className="mx-auto max-w-3xl">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-accent"><span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />Your creative workspace</p>
          <h1 id="home-heading" className="mt-5 text-4xl font-semibold leading-[1.1] tracking-[-0.04em] text-text-primary sm:text-5xl">
            What will you create today?
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-secondary">
            Start with an idea. Build something useful. Make it better, together.
          </p>
          <div className="mt-8">
            <HomeComposer initialPrompt={prompt} isRunning={isRunning || isChatting} onSubmit={handleRun} />
          </div>
        </section>

        <section aria-labelledby="project-actions-heading" className="mt-14 rounded-2xl border border-border bg-surface p-5 sm:p-7">
          <h2 id="project-actions-heading" className="text-base font-semibold tracking-tight text-text-primary">
            Bring your project
          </h2>
          <p className="mt-1 text-sm text-text-secondary">Start fresh or pick up where you left off.</p>
          {projectError ? <p role="alert" className="mt-3 text-sm text-danger">{projectError}</p> : null}
          <div className="mt-3">
            <ProjectActions
              isBusy={isProjectBusy}
              onCreate={async (name) => {
                if (await createProject(name)) onEnterWorkspace();
              }}
              onOpen={async (path) => {
                if (await openProjectByPath(path)) onEnterWorkspace();
              }}
              onClone={async (repositoryUrl) => {
                if (await cloneGithubProject(repositoryUrl)) onEnterWorkspace();
              }}
            />
          </div>
        </section>

        <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-7">
          <RecentProjects
            projects={recentProjects}
            onOpen={async (path) => {
              if (await openProjectByPath(path)) onEnterWorkspace();
            }}
          />
        </div>

        <div className="min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-7">
          <RecentTasks tasks={runHistory} />
        </div>
        </div>
      </main>
    </div>
  );
}
