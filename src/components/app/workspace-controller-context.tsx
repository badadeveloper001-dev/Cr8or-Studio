"use client";

import { createContext, useContext, type ReactNode } from "react";

import { useWorkspaceController } from "@/hooks/use-workspace-controller";

export type WorkspaceController = ReturnType<typeof useWorkspaceController>;

const WorkspaceControllerContext = createContext<WorkspaceController | null>(null);

export function WorkspaceControllerProvider({
  controller,
  children,
}: {
  controller: WorkspaceController;
  children: ReactNode;
}) {
  return (
    <WorkspaceControllerContext.Provider value={controller}>{children}</WorkspaceControllerContext.Provider>
  );
}

export function useWorkspaceControllerContext(): WorkspaceController {
  const controller = useContext(WorkspaceControllerContext);
  if (!controller) {
    throw new Error("useWorkspaceControllerContext must be used within a WorkspaceControllerProvider.");
  }
  return controller;
}
