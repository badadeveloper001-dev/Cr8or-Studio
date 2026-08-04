import path from "node:path";
import { promises as fs } from "node:fs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PROJECTS_ROOT, resolveWorkspacePath, runShell, sanitizeWorkspacePath, WORKSPACE_ROOT } from "@/lib/workspace/shell";

const bodySchema = z.object({
  action: z.enum(["create", "open", "clone", "recent"]),
  name: z.string().min(2).max(120).optional(),
  path: z.string().optional(),
  repositoryUrl: z.string().url().optional(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function readRecentProjects() {
  try {
    const dirs = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = await Promise.all(
      dirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const relPath = path.join("projects", entry.name);
          const absPath = path.join(PROJECTS_ROOT, entry.name);
          const stat = await fs.stat(absPath);
          return {
            name: entry.name,
            path: relPath.replace(/\\/g, "/"),
            updatedAt: stat.mtime.toISOString(),
          };
        }),
    );

    return projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch {
    return [];
  }
}

async function listFiles(projectAbsPath: string) {
  const items = await fs.readdir(projectAbsPath, { withFileTypes: true });
  return items.slice(0, 50).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "folder" : "file",
  }));
}

export async function POST(request: NextRequest) {
  try {
    await fs.mkdir(PROJECTS_ROOT, { recursive: true });
    const raw = await request.json();
    const payload = bodySchema.parse(raw);

    if (payload.action === "recent") {
      const projects = await readRecentProjects();
      return NextResponse.json({ projects }, { status: 200 });
    }

    if (payload.action === "create") {
      if (!payload.name) {
        return NextResponse.json({ message: "Project name is required." }, { status: 400 });
      }
      const slug = slugify(payload.name);
      const relPath = path.join("projects", slug).replace(/\\/g, "/");
      const projectPath = resolveWorkspacePath(relPath);

      if (!projectPath) {
        return NextResponse.json({ message: "Invalid project path." }, { status: 400 });
      }

      await fs.mkdir(projectPath, { recursive: true });
      const readmePath = path.join(projectPath, "README.md");
      await fs.writeFile(readmePath, `# ${payload.name}\n\nCreated in Cr8or Studio.\n`, "utf8");

      return NextResponse.json(
        {
          project: {
            name: payload.name,
            path: relPath,
            files: await listFiles(projectPath),
          },
        },
        { status: 201 },
      );
    }

    if (payload.action === "open") {
      const safe = sanitizeWorkspacePath(payload.path ?? "");
      if (!safe) {
        return NextResponse.json({ message: "Invalid project path." }, { status: 400 });
      }
      const projectPath = resolveWorkspacePath(safe);
      if (!projectPath) {
        return NextResponse.json({ message: "Invalid project path." }, { status: 400 });
      }

      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) {
        return NextResponse.json({ message: "Project path is not a directory." }, { status: 400 });
      }

      return NextResponse.json(
        {
          project: {
            name: path.basename(projectPath),
            path: safe,
            files: await listFiles(projectPath),
          },
        },
        { status: 200 },
      );
    }

    if (payload.action === "clone") {
      if (!payload.repositoryUrl) {
        return NextResponse.json({ message: "Repository URL is required." }, { status: 400 });
      }

      const repoName = payload.repositoryUrl.split("/").pop()?.replace(/\.git$/, "") || "project";
      const safeName = slugify(payload.name || repoName || "project");
      const relPath = path.join("projects", safeName).replace(/\\/g, "/");
      const projectPath = resolveWorkspacePath(relPath);
      if (!projectPath) {
        return NextResponse.json({ message: "Invalid clone destination." }, { status: 400 });
      }

      try {
        await fs.stat(projectPath);
        return NextResponse.json({ message: "Destination already exists." }, { status: 409 });
      } catch {
        // expected if folder does not exist
      }

      await runShell(`git clone ${payload.repositoryUrl} ${projectPath}`, WORKSPACE_ROOT);

      return NextResponse.json(
        {
          project: {
            name: safeName,
            path: relPath,
            files: await listFiles(projectPath),
          },
        },
        { status: 201 },
      );
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: "Invalid request payload.", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ message: "Workspace project operation failed." }, { status: 500 });
  }
}
