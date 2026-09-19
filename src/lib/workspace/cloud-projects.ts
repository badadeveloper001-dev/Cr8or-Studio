import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import type { ProjectRef } from "@/lib/workspace/project-ref";

export function cloudModeEnabled(): boolean {
  return Boolean(process.env.VERCEL_ENV) || process.env.CR8OR_WORKSPACE_MODE === "cloud";
}

export function parseRepository(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("Use a GitHub repository URL such as https://github.com/owner/repo.");
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(url.pathname);
  if (!match) throw new Error("Use the repository URL, without a file or branch path.");
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");
  if (!repo || [owner, repo].some((part) => part === "." || part === "..")) throw new Error("Invalid repository URL.");
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export function cloudProjectId(actorId: string, repositoryUrl: string, branch?: string): string {
  return `cloud-${createHash("sha256").update(`${actorId}\n${repositoryUrl.toLowerCase()}\n${branch ?? ""}`).digest("hex").slice(0, 32)}`;
}

// The creator is recorded on the Project without introducing a database migration.
export function cloudOwnerDescription(actorId: string): string {
  return `cr8or-owner:${createHash("sha256").update(actorId).digest("hex")}`;
}

export function cloudProjectRef(workspace: { projectId: string; providerWorkspaceId: string | null; projectName: string | null; repositoryUrl: string | null; updatedAt: Date }): ProjectRef {
  return {
    name: workspace.projectName || workspace.repositoryUrl?.split("/").pop() || workspace.projectId,
    path: workspace.projectId,
    projectId: workspace.projectId,
    runtimeType: "cloud",
    repositoryUrl: workspace.repositoryUrl || undefined,
    updatedAt: workspace.updatedAt.toISOString(),
  };
}

export async function findCloudProject(projectId: string, actorId: string, role: string) {
  return prisma.workspace.findFirst({
    where: { projectId, runtimeType: "cloud", ...(role === "owner" ? {} : { project: { description: cloudOwnerDescription(actorId) } }) },
  });
}
