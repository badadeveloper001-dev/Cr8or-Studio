import { z } from "zod";

export const projectRefSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  runtimeType: z.enum(["local", "cloud"]).optional(),
  repositoryUrl: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ProjectRef = z.infer<typeof projectRefSchema>;
export const workspaceResponseSchema = z.object({ ok: z.literal(true), project: projectRefSchema });

export function projectIdFor(project: ProjectRef): string {
  return project.projectId || (project.path === "." ? "cr8or-studio" : project.path);
}
