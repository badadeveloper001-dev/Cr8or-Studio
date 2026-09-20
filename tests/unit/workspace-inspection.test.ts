import { describe, expect, it } from "vitest";
import { performReadOnlyTaskLoop, performLocalReadinessCheck } from "@/lib/workspace/workspace-inspection";
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

describe("performReadOnlyTaskLoop", () => {
  it("returns empty workspace message for empty root", async () => {
    const runtime = createMockRuntime({}, { ".": [] });
    const result = await performReadOnlyTaskLoop(runtime);
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
    const result = await performReadOnlyTaskLoop(runtime);
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
    const result = await performReadOnlyTaskLoop(runtime);
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
    const result = await performReadOnlyTaskLoop(runtime);
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
    const result = await performReadOnlyTaskLoop(runtime);
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
    const result = await performReadOnlyTaskLoop(runtime);
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
    const result = await performReadOnlyTaskLoop(runtime);
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
    const result = await performReadOnlyTaskLoop(runtime);
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions.some((s) => s.toLowerCase().includes("file"))).toBe(true);
  });

  it("handles workspace read errors gracefully", async () => {
    const runtime = createMockRuntime({}, {});
    const result = await performReadOnlyTaskLoop(runtime);
    expect(result.reply).toContain("empty or inaccessible");
  });

  it("performs multiple read actions in a single pass", async () => {
    const runtime = createMockRuntime(
      {
        "package.json": '{"name":"multi-action-test"}',
        "src/app/layout.tsx": "export default function RootLayout() {}",
        ".env.example": "DATABASE_URL=...NEXT_PUBLIC_SUPABASE_URL=...",
      },
      {
        ".": [
          { name: "src", type: "directory" },
          { name: "package.json", type: "file" },
          { name: ".env.example", type: "file" },
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
    const result = await performReadOnlyTaskLoop(runtime);
    expect(result.reply).toContain("multi-action-test");
    expect(result.reply).toContain("Files read: 2");
    expect(result.reply).toContain("Actions taken:");
  });

  it("reports actions taken in summary", async () => {
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
    const result = await performReadOnlyTaskLoop(runtime);
    expect(result.reply).toContain("Actions taken:");
  });
});

describe("performLocalReadinessCheck", () => {
  it("returns empty workspace message for empty root", async () => {
    const runtime = createMockRuntime({}, { ".": [] });
    const result = await performLocalReadinessCheck(runtime);
    expect(result.reply).toContain("empty or inaccessible");
  });

  it("detects ready project with all prerequisites", async () => {
    const runtime = createMockRuntime(
      {
        "package.json": '{"scripts":{"dev":"next dev","start":"next start"},"dependencies":{"next":"15.0.0","react":"18.0.0"}}',
        ".env.example": "NEXT_PUBLIC_API_URL=...",
        "next.config.js": "module.exports = {}",
        "package-lock.json": "{}",
      },
      {
        ".": [
          { name: "src", type: "directory" },
          { name: "package.json", type: "file" },
          { name: ".env.example", type: "file" },
          { name: "next.config.js", type: "file" },
          { name: "package-lock.json", type: "file" },
        ],
      },
    );
    const result = await performLocalReadinessCheck(runtime);
    expect(result.reply).toContain("Ready to run locally");
    expect(result.reply).toContain("package.json present");
    expect(result.reply).toContain("dev script available");
    expect(result.reply).toContain(".env.example found");
  });

  it("detects not ready project with missing prerequisites", async () => {
    const runtime = createMockRuntime(
      {
        "package.json": '{"scripts":{}}',
      },
      {
        ".": [
          { name: "package.json", type: "file" },
        ],
      },
    );
    const result = await performLocalReadinessCheck(runtime);
    expect(result.reply).toContain("Not ready");
    expect(result.reply).toContain("No dev or start script");
    expect(result.reply).toContain("No .env.example");
    expect(result.reply).toContain("No lockfile");
  });

  it("reports env vars needed from .env.example", async () => {
    const runtime = createMockRuntime(
      {
        "package.json": '{"scripts":{"dev":"next dev"},"dependencies":{"next":"15.0.0"}}',
        ".env.example": "DATABASE_URL=...\nNEXT_PUBLIC_SUPABASE_URL=...",
        "package-lock.json": "{}",
      },
      {
        ".": [
          { name: "package.json", type: "file" },
          { name: ".env.example", type: "file" },
          { name: "package-lock.json", type: "file" },
        ],
      },
    );
    const result = await performLocalReadinessCheck(runtime);
    expect(result.reply).toContain("Environment variables needed");
    expect(result.reply).toContain("DATABASE_URL");
    expect(result.reply).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("includes next steps section", async () => {
    const runtime = createMockRuntime(
      { "package.json": "{}" },
      {
        ".": [
          { name: "package.json", type: "file" },
        ],
      },
    );
    const result = await performLocalReadinessCheck(runtime);
    expect(result.reply).toContain("Next Steps");
    expect(result.reply).toContain("npm install");
    expect(result.reply).toContain("npm run dev");
  });

  it("handles workspace read errors gracefully", async () => {
    const runtime = createMockRuntime({}, {});
    const result = await performLocalReadinessCheck(runtime);
    expect(result.reply).toContain("empty or inaccessible");
  });
});
