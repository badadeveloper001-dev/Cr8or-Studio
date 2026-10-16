import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { cloudPath } from "@/lib/workspace/cloud-path";
import { getActiveProjectRoot } from "@/lib/workspace/shell";

/** Reject secret paths and traversal before touching the host filesystem. */
export function privateRuntimeRelativePath(input: string): string {
  if (typeof input !== "string" || !input || input.includes("\0") || path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    throw new Error("Path must stay inside the authorized project.");
  }
  // The cloud path validator applies component-based secret exclusions too.
  cloudPath(input);
  return input.replace(/\\/g, "/");
}

/**
 * Private local runtimes never follow symlinks, including the project root.
 * Missing descendants are allowed only for writes; the registered root must exist.
 * Host command execution is disabled in private mode, so agent code cannot race
 * these checks by changing links in another process. The host itself is trusted.
 */
export async function privateLocalPath(projectId: string, input: string, allowMissing = false): Promise<string> {
  const idParts = projectId.replace(/\\/g, "/").split("/");
  if (!projectId || path.isAbsolute(projectId) || /^[A-Za-z]:/.test(projectId) ||
      idParts.some((part) => !part || part === "." || part === "..") || projectId === "projects") {
    throw new Error("Invalid registered local project path.");
  }
  const relative = privateRuntimeRelativePath(input);
  const root = path.resolve(getActiveProjectRoot(projectId));
  const realRoot = await fs.realpath(root);
  if (realRoot !== root) throw new Error("Symbolic project roots are not authorized.");
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error("Path must stay inside the authorized project.");

  let current = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
        throw new Error("Linked files and directories are not authorized.");
      }
      if (!info.isFile() && !info.isDirectory()) throw new Error("Special files are not authorized.");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
      throw error;
    }
  }
  return absolute;
}
