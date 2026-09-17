"use client";

import { useState } from "react";

import { WorkspaceControllerProvider } from "@/components/app/workspace-controller-context";
import { HomeView } from "@/components/home/home-view";
import type { WorkspaceSection } from "@/components/workspace/nav-rail";
import { WorkspaceView } from "@/components/workspace/workspace-view";
import { useWorkspaceController } from "@/hooks/use-workspace-controller";

type Surface = "home" | "workspace";

export function WorkspaceApp() {
  const controller = useWorkspaceController();
  const [surface, setSurface] = useState<Surface>("home");
  const [initialSection, setInitialSection] = useState<WorkspaceSection>("tasks");

  const openWorkspace = (section: WorkspaceSection = "tasks") => {
    setInitialSection(section);
    setSurface("workspace");
  };

  return (
    <WorkspaceControllerProvider controller={controller}>
      {surface === "home" ? (
        <HomeView
          onEnterWorkspace={() => openWorkspace("tasks")}
          onOpenSettings={() => openWorkspace("settings")}
        />
      ) : (
        <WorkspaceView initialSection={initialSection} onExitToHome={() => setSurface("home")} />
      )}
    </WorkspaceControllerProvider>
  );
}
