import { LocalWorkspaceRuntime } from "@/lib/workspace/runtime-local";
import { CloudWorkspaceRuntime } from "@/lib/workspace/runtime-cloud";
import { prisma } from "@/lib/db/prisma";

interface WorkspaceConfig {
  id: string;
  type: "local" | "cloud";
  projectId: string;
  provider?: string;
  providerWorkspaceId?: string;
  repositoryUrl?: string;
  branch?: string;
}

interface ProjectWorkspaceConfig {
  type: "local" | "cloud";
  cloudConfig?: {
    provider: string;
    providerWorkspaceId: string;
    repositoryUrl?: string;
    branch?: string;
  };
}

function normalizeProjectId(projectId: string): string {
  if (!projectId || projectId === "cr8or-studio" || projectId === "workspace-root") {
    return "cr8or-studio";
  }
  return projectId;
}

async function getProjectWorkspaceConfig(projectId: string) {
  const normalizedId = normalizeProjectId(projectId);
  const workspace = await prisma.workspace.findUnique({
    where: { projectId: normalizedId },
  });
  
  if (!workspace) {
    return { type: "local" as const };
  }
  
  return {
    type: workspace.runtimeType as "local" | "cloud",
    cloudConfig: workspace.provider ? {
      provider: workspace.provider,
      providerWorkspaceId: workspace.providerWorkspaceId || undefined,
      repositoryUrl: workspace.repositoryUrl || undefined,
      branch: workspace.branch || undefined,
    } : undefined,
  };
}

export async function getWorkspaceRuntime(projectId: string): Promise<any> {
  const normalizedId = normalizeProjectId(projectId);
  const config = await getProjectWorkspaceConfig(projectId);

  if (config.type === "cloud" && config.cloudConfig) {
    const { CloudWorkspaceRuntime } = await import("@/lib/workspace/runtime-cloud");
    return new CloudWorkspaceRuntime({
      id: `cloud-${normalizeProjectId(projectId)}`,
      projectId: normalizeProjectId(projectId),
      provider: config.cloudConfig.provider,
      providerWorkspaceId: config.cloudConfig.providerWorkspaceId,
      repositoryUrl: config.cloudConfig.repositoryUrl,
      branch: config.cloudConfig.branch,
      createdAt: new Date(),
    });
  }

  const { LocalWorkspaceRuntime } = await import("@/lib/workspace/runtime-local");
  return new LocalWorkspaceRuntime(normalizeProjectId(projectId));
}

export async function setProjectToCloud(
  projectId: string,
  provider: string,
  providerWorkspaceId: string,
  repositoryUrl?: string,
  branch?: string
): Promise<void> {
  const normalizedId = normalizeProjectId(projectId);
  
  await prisma.workspace.upsert({
    where: { projectId: normalizeProjectId(projectId) },
    update: {
      runtimeType: "cloud",
      provider,
      providerWorkspaceId,
      repositoryUrl,
      branch,
      state: "ready",
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    },
    create: {
      projectId: normalizeProjectId(projectId),
      runtimeType: "cloud",
      provider,
      providerWorkspaceId,
      repositoryUrl,
      branch,
      state: "ready",
    },
  });
}

export async function setProjectToLocal(projectId: string): Promise<void> {
  const normalizedId = normalizeProjectId(projectId);
  
  await prisma.workspace.upsert({
    where: { projectId: normalizeProjectId(projectId) },
    update: {
      runtimeType: "local",
      provider: null,
      providerWorkspaceId: null,
      repositoryUrl: null,
      branch: null,
      state: "ready",
      updatedAt: new Date(),
      lastActiveAt: new Date(),
    },
    create: {
      projectId: normalizeProjectId(projectId),
      runtimeType: "local",
      state: "ready",
    },
  });
}

export async function getProjectWorkspaceType(projectId: string): Promise<"local" | "cloud"> {
  const normalizedId = normalizeProjectId(projectId);
  const workspace = await prisma.workspace.findUnique({
    where: { projectId: normalizedId },
  });
  return (workspace?.runtimeType as "local" | "cloud") || "local";
}

export async function getWorkspaceConfig(projectId: string) {
  return getProjectWorkspaceConfig(projectId);
}