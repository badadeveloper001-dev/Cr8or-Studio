import "server-only";

import { prisma } from "@/lib/db/prisma";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import { ExecutionAuthorizationError, revalidateExecutionAuthorization, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";

function normalizeProjectId(projectId: string): string {
  if (!projectId || projectId === "cr8or-studio" || projectId === "workspace-root") {
    return "cr8or-studio";
  }
  return projectId;
}

async function getProjectWorkspaceConfig(projectId: string) {
  if (!process.env.DATABASE_URL && !process.env.VERCEL_ENV && process.env.CR8OR_WORKSPACE_MODE !== "cloud" && !projectId.startsWith("cloud-")) return { type: "local" as const };
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

export async function getWorkspaceRuntime(projectId: string, authorization?: ExecutionAuthorizationContext) {
  if (authorization || getPrivateAuthMode() === "required") {
    await revalidateExecutionAuthorization(authorization, projectId, "read");
    if (!authorization) throw new ExecutionAuthorizationError(401);
    const workspace = authorization.workspace;
    if (workspace.runtimeType === "cloud") {
      if (workspace.provider !== "daytona" || !workspace.providerWorkspaceId) {
        throw new ExecutionAuthorizationError(503, "The registered workspace is unavailable.");
      }
      const apiKey = process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new ExecutionAuthorizationError(503, "The registered workspace is unavailable.");
      const { DaytonaProvider } = await import("@/lib/workspace/providers/daytona");
      const { CloudWorkspaceRuntime } = await import("@/lib/workspace/runtime-cloud");
      const runtime = new CloudWorkspaceRuntime({
        id: `cloud-${projectId}`,
        projectId,
        provider: new DaytonaProvider({ apiKey, apiUrl: process.env.DAYTONA_API_URL }),
        providerWorkspaceId: workspace.providerWorkspaceId,
        repositoryUrl: workspace.repositoryUrl ?? undefined,
        branch: workspace.branch ?? undefined,
        createdAt: new Date(),
        authorization,
      });
      await runtime.initialize();
      return runtime;
    }
    if (process.env.VERCEL_ENV || process.env.CR8OR_WORKSPACE_MODE === "cloud") {
      throw new ExecutionAuthorizationError(503, "The registered workspace is unavailable.");
    }
    const { LocalWorkspaceRuntime } = await import("@/lib/workspace/runtime-local");
    return new LocalWorkspaceRuntime(projectId, authorization);
  }
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
    const runtime = new CloudWorkspaceRuntime({
      id: `cloud-${normalizeProjectId(projectId)}`,
      projectId: normalizeProjectId(projectId),
      provider,
      providerWorkspaceId: config.cloudConfig.providerWorkspaceId || "",
      repositoryUrl: config.cloudConfig.repositoryUrl,
      branch: config.cloudConfig.branch,
      createdAt: new Date(),
    });
    await runtime.initialize();
    return runtime;
  }

  if (process.env.VERCEL_ENV || process.env.CR8OR_WORKSPACE_MODE === "cloud" || projectId.startsWith("cloud-")) throw new Error("Select or clone a cloud project before accessing workspace files.");
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
  if (getPrivateAuthMode() === "required") throw new ExecutionAuthorizationError(503, "Workspace reassignment is unavailable.");
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
  if (getPrivateAuthMode() === "required") throw new ExecutionAuthorizationError(503, "Workspace reassignment is unavailable.");
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
