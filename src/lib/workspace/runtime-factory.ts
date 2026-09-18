import { LocalWorkspaceRuntime } from "@/lib/workspace/runtime-local";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime";

function normalizeProjectId(projectId: string): string {
  if (!projectId || projectId === "cr8or-studio" || projectId === "workspace-root") {
    return "cr8or-studio";
  }
  return projectId;
}

export function getWorkspaceRuntime(projectId: string): WorkspaceRuntime {
  const normalizedId = normalizeProjectId(projectId);
  return new LocalWorkspaceRuntime(normalizedId);
}