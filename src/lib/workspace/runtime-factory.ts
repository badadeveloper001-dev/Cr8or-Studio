import { prisma } from "@/lib/db/prisma";

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

export async function getWorkspaceRuntime(projectId: string) {
  const config = await getProjectWorkspaceConfig(projectId);

  if (config.type === "cloud" && config.cloudConfig) {
    const apiKey = process.env.DAYTONA_API_KEY;
    const apiUrl = process.env.DAYTONA_API_URL;
    if (!apiKey) {
      throw new Error("DAYTONA_API_KEY environment variable is required for cloud workspaces");
    }
    const { DaytonaProvider } = await import("@/lib/workspace/providers/daytona");
    const provider = new DaytonaProvider({ apiKey, apiUrl });
    const { CloudWorkspaceRuntime } = await import("@/lib/workspace/runtime-cloud");
    return new CloudWorkspaceRuntime({
      id: `cloud-${normalizeProjectId(projectId)}`,
      projectId: normalizeProjectId(projectId),
      provider,
      providerWorkspaceId: config.cloudConfig.providerWorkspaceId || "",
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
  const workspace = await prisma.workspace.findUnique({
    where: { projectId: normalizeProjectId(projectId) },
  });
  return (workspace?.runtimeType as "local" | "cloud") || "local";
}

export async function getWorkspaceConfig(projectId: string) {
  return getProjectWorkspaceConfig(projectId);
}
