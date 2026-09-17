import { promises as fs } from "node:fs";
import path from "node:path";

import { PROJECTS_ROOT, sanitizeWorkspacePath } from "@/lib/workspace/shell";

export type ProjectRef = {
  name: string;
  path: string;
  updatedAt?: string;
};

export type ProjectFileEntry = {
  name: string;
  type: "file" | "folder";
};

export function slugifyProjectName(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return slug.length > 0 ? slug : null;
}

export function projectDirNameFromUrl(repositoryUrl: string): string {
  const url = repositoryUrl.trim();
  const withoutSuffix = url.replace(/\.git$/i, "");
  const segments = withoutSuffix.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export async function ensureProjectsRoot(): Promise<void> {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
}

export function resolveProjectDir(input: string): string | null {
  const safe = (sanitizeWorkspacePath(input) ?? "").replace(/\/+$/, "");
  if (!safe || safe === "." || safe === "projects") {
    return null;
  }

  const relative = safe.startsWith("projects/") ? safe.slice("projects/".length) : safe;
  if (!relative || relative.split("/").some((segment) => segment.length === 0)) {
    return null;
  }

  const absolute = path.resolve(PROJECTS_ROOT, relative);
  if (absolute !== PROJECTS_ROOT && !absolute.startsWith(`${PROJECTS_ROOT}${path.sep}`)) {
    return null;
  }

  return absolute;
}

export function toProjectRef(projectDir: string): ProjectRef {
  const relative = path.relative(PROJECTS_ROOT, projectDir).split(path.sep).join("/");
  const name = relative.split("/").pop() || relative;
  return {
    name,
    path: `projects/${relative}`,
  };
}

export async function listProjectFiles(projectDir: string): Promise<ProjectFileEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      type: (entry.isDirectory() ? "folder" : "file") as "folder" | "file",
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export async function scanRecentProjects(): Promise<ProjectRef[]> {
  let entries;
  try {
    entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects: ProjectRef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const projectDir = path.join(PROJECTS_ROOT, entry.name);
    let updatedAt: string | undefined;
    try {
      const stat = await fs.stat(projectDir);
      updatedAt = stat.mtime.toISOString();
    } catch {
      // leave updatedAt undefined
    }

    projects.push({ ...toProjectRef(projectDir), updatedAt });
  }

  return projects.sort((a, b) => {
    if (a.updatedAt && b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    if (a.updatedAt) return -1;
    if (b.updatedAt) return 1;
    return a.name.localeCompare(b.name);
  });
}