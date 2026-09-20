import { describe, expect, it, vi } from "vitest";
import { performWorkspaceInspection } from "@/lib/workspace/workspace-inspection";
import type { WorkspaceRuntime, WorkspaceMetadata, GitStatusResult, GitDiffResult, CommandResult, ValidatedCommandRequest } from "@/lib/workspace/runtime";

function createMockRuntime(files: Record<string, string>, dirs: Record<string, Array<{ name: string; type: "file" | "directory" }>>): WorkspaceRuntime {
  return {
    id: "test",
    type: "cloud" as const,
    projectId: "test-project",
    capabilities: { preview: false, sleep: false, persistentStorage: false, gitSupport: false, nodeSupport: false },
    async readFile(path: string) {
      const content = files[path];
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return { content, bytes: content.length };
    },
    async writeFile() { return { bytes: 0 }; },
    async listFiles(path?: string) {
      const key = path || ".";
      const entries = dirs[key];
      if (!entries) throw new Error(`Directory not found: ${key}`);
      return entries;
    },
    async gitStatus(): Promise<GitStatusResult> { return { branch: "main", changes: "", changedFiles: [], changedCount: 0 }; },
    async gitDiff(): Promise<GitDiffResult> { return { diff: "", stagedDiff: "" }; },
    async runCommand(): Promise<CommandResult> { return { stdout: "", stderr: "", exitCode: 0 }; },
    async getMetadata(): Promise<WorkspaceMetadata> {
      return { id: "test", type: "cloud", projectId: "test-project", capabilities: { preview: false, sleep: false, persistentStorage: false, gitSupport: false, nodeSupport: false }, state: "ready", createdAt: new Date(), lastActiveAt: new Date() };
    },
  };
}

describe("performWorkspaceInspection", () => {
  it("returns empty workspace message for empty root", async () => {
    const runtime = createMockRuntime({}, { ".": [] });
    const result = await performWorkspaceInspection(runtime);
    expect(result.reply).toContain("empty or inaccessible");
  });

  it("lists root folders from workspace", async () => {
    const runtime = createMockRuntime(
      { "package.json": '{"name":"test-app"}' },
      {
        ".": [
          { name: "src", type: "directory" },
          { name: "public", type: "directory" },
          { name: "package.json", type: "file" },
        ],
        src: [
          { name: "app", type: "directory" },
          { name: "lib", type: "directory" },
        ],
        "src/app": [
          { name: "page.tsx", type: "file" },
          { name: "layout.tsx", type: "file" },
        ],
        "src/lib": [
          { name: "utils.ts", type: "file" },
        ],
        public: [],
      },
    );
    const result = await performWorkspaceInspection(runtime);
    expect(result.reply).toContain("src/");
    expect(result.reply).toContain("public/");
    expect(result.reply).toContain("package.json");
  });

  it("identifies important directories with purposes", async () => {
    const runtime = createMockRuntime(
      { "package.json": "{}" },
      {
        ".": [
          { name: "src", type: "directory" },
          { name: "prisma", type: "directory" },
          { name: "supabase", type: "directory" },
          { name: "package.json", type: "file" },
        ],
        src: [
          { name: "app", type: "directory" },
          { name: "lib", type: "directory" },
          { name: "components", type: "directory" },
        ],
        "src/app": [],
        "src/lib": [],
        "src/components": [],
        prisma: [{ name: "schema.prisma", type: "file" }],
        supabase: [{ name: "config.toml", type: "file" }],
      },
    );
    const result = await performWorkspaceInspection(runtime);
    expect(result.reply).toContain("Main source code directory");
    expect(result.reply).toContain("Prisma database schema");
    expect(result.reply).toContain("Supabase configuration");
  });

  it("detects entry point from actual files", async () => {
    const runtime = createMockRuntime(
      { "package.json": "{}" },
      {
        ".": [
          { name: "src", type: "directory" },
          { name: "package.json", type: "file" },
        ],
        src: [
          { name: "app", type: "directory" },
        ],
        "src/app": [
          { name: "page.tsx", type: "file" },
          { name: "layout.tsx", type: "file" },
        ],
      },
    );
    const result = await performWorkspaceInspection(runtime);
    expect(result.reply).toContain("src/app/page.tsx");
    expect(result.reply).toContain("verified");
  });

  it("detects Supabase location from directory names", async () => {
    const runtime = createMockRuntime(
      { "package.json": "{}" },
      {
        ".": [
          { name: "src", type: "directory" },
          { name: "supabase", type: "directory" },
          { name: "package.json", type: "file" },
        ],
        src: [],
        supabase: [
          { name: "config.toml", type: "file" },
          { name: "migrations", type: "directory" },
        ],
      },
    );
    const result = await performWorkspaceInspection(runtime);
    expect(result.reply.toLowerCase()).toContain("supabase");
  });

  it("detects Supabase from file content when no supabase dir exists", async () => {
    const runtime = createMockRuntime(
      {
        "package.json": "{}",
        "src/lib/supabase-client.ts": "import { createClient } from '@supabase/supabase-js'",
      },
      {
        ".": [
          { name: "src", type: "directory" },
          { name: "package.json", type: "file" },
        ],
        src: [
          { name: "lib", type: "directory" },
        ],
        "src/lib": [
          { name: "supabase-client.ts", type: "file" },
        ],
      },
    );
    const result = await performWorkspaceInspection(runtime);
    expect(result.reply.toLowerCase()).toContain("supabase");
  });

  it("detects architecture pattern", async () => {
    const runtime = createMockRuntime(
      { "package.json": "{}" },
      {
        ".": [
          { name: "src", type: "directory" },
          { name: "package.json", type: "file" },
        ],
        src: [
          { name: "app", type: "directory" },
        ],
        "src/app": [],
      },
    );
    const result = await performWorkspaceInspection(runtime);
    expect(result.reply).toContain("Next.js App Router");
  });

  it("returns suggestions for follow-up actions", async () => {
    const runtime = createMockRuntime(
      { "package.json": "{}" },
      {
        ".": [
          { name: "package.json", type: "file" },
        ],
      },
    );
    const result = await performWorkspaceInspection(runtime);
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions.some((s) => s.toLowerCase().includes("file"))).toBe(true);
  });

  it("handles workspace read errors gracefully", async () => {
    const runtime = createMockRuntime({}, {});
    const result = await performWorkspaceInspection(runtime);
    expect(result.reply).toContain("empty or inaccessible");
  });
});
