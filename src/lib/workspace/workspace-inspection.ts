import type { WorkspaceRuntime } from "@/lib/workspace/runtime";

const KNOWN_DIR_PURPOSES: Record<string, string> = {
  src: "Main source code directory",
  app: "Next.js App Router pages and layouts",
  pages: "Next.js Pages Router routes",
  lib: "Shared library code and utilities",
  components: "Reusable UI components",
  hooks: "Custom React hooks",
  utils: "Utility functions and helpers",
  api: "API route handlers",
  services: "Service layer and external integrations",
  config: "Configuration files and modules",
  prisma: "Prisma database schema and migrations",
  supabase: "Supabase configuration, migrations, and client setup",
  database: "Database configuration and migrations",
  scripts: "Build and automation scripts",
  public: "Static assets served directly",
  styles: "CSS and style definitions",
  types: "TypeScript type definitions and interfaces",
  tests: "Test files and test utilities",
  test: "Test files",
  __tests__: "Test files",
  e2e: "End-to-end test files",
  migrations: "Database migration files",
  seed: "Database seed scripts",
  middleware: "Request middleware",
  actions: "Server actions",
  routes: "Route definitions",
};

const SUPABASE_MARKERS = [
  "supabase",
  "createClient",
  "supabaseClient",
  "@supabase",
  "supabaseAuth",
  "supabaseAdmin",
];

const LAYOUT_CANDIDATES = [
  "src/app/layout.tsx",
  "app/layout.tsx",
  "src/app/layout.ts",
  "app/layout.ts",
];

const PACKAGE_JSON = "package.json";

const ROOT_CONFIG_FILES = [
  "package.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "tsconfig.json",
  "tailwind.config.js",
  "tailwind.config.ts",
  ".env.example",
  "prisma/schema.prisma",
  "capacitor.config.ts",
  "capacitor.config.json",
];

const MAX_ROOT_ENTRIES = 60;
const MAX_SUBDIR_ENTRIES = 40;
const MAX_FILES_READ = 12;
const MAX_SUBDIRS_INSPECTED = 8;

function isHiddenOrGenerated(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === ".next" || name === "dist" || name === "build" || name === ".vercel" || name === ".git";
}

async function safeReadFile(runtime: WorkspaceRuntime, filePath: string): Promise<string | null> {
  try {
    const result = await runtime.readFile(filePath);
    return result.content;
  } catch {
    return null;
  }
}

async function safeListDir(runtime: WorkspaceRuntime, dirPath: string): Promise<Array<{ name: string; type: "file" | "directory" }> | null> {
  try {
    const entries = await runtime.listFiles(dirPath);
    return entries;
  } catch {
    return null;
  }
}

function detectEntryPoint(rootEntries: Array<{ name: string; type: "file" | "directory" }>, srcEntries: Array<{ name: string; type: "file" | "directory" }> | null): string | null {
  const hasSrc = rootEntries.some((e) => e.name === "src" && e.type === "directory");
  const hasApp = rootEntries.some((e) => e.name === "app" && e.type === "directory");
  const hasPages = rootEntries.some((e) => e.name === "pages" && e.type === "directory");

  if (hasSrc && srcEntries) {
    const hasSrcApp = srcEntries.some((e) => e.name === "app" && e.type === "directory");
    if (hasSrcApp) {
      const srcAppEntries = srcEntries.filter((e) => e.name === "app");
      if (srcAppEntries.length > 0) {
        return "src/app/page.tsx";
      }
    }
    return "src/app/page.tsx";
  }

  if (hasApp) {
    return "app/page.tsx";
  }

  if (hasPages) {
    return "pages/index.tsx";
  }

  return null;
}

function detectArchitecture(
  rootEntries: Array<{ name: string; type: "file" | "directory" }>,
  hasSrc: boolean,
  hasApp: boolean,
  hasPages: boolean,
): string | null {
  if (hasApp && hasSrc) return "Next.js App Router (src/app/)";
  if (hasApp) return "Next.js App Router";
  if (hasPages) return "Next.js Pages Router";
  return null;
}

export async function performWorkspaceInspection(
  runtime: WorkspaceRuntime,
): Promise<{ reply: string; suggestions: string[] }> {
  const rootEntries = await safeListDir(runtime, ".");
  if (!rootEntries || rootEntries.length === 0) {
    return {
      reply: "The workspace root is empty or inaccessible.",
      suggestions: ["Check workspace status in the activity panel"],
    };
  }

  const rootFolders: string[] = [];
  const rootFiles: string[] = [];
  for (const entry of rootEntries.slice(0, MAX_ROOT_ENTRIES)) {
    if (entry.type === "directory") {
      rootFolders.push(entry.name);
    } else {
      rootFiles.push(entry.name);
    }
  }

  const importantFolders: Array<{ name: string; purpose: string }> = [];
  const dirsToInspect: string[] = [];

  for (const name of rootFolders) {
    if (isHiddenOrGenerated(name)) continue;
    const purpose = KNOWN_DIR_PURPOSES[name] || null;
    if (purpose) {
      importantFolders.push({ name, purpose });
      dirsToInspect.push(name);
    }
  }

  const hasSrc = rootFolders.includes("src");
  const hasPages = rootFolders.includes("pages");

  let srcEntries: Array<{ name: string; type: "file" | "directory" }> | null = null;
  if (hasSrc) {
    srcEntries = await safeListDir(runtime, "src");
    if (srcEntries) {
      for (const entry of srcEntries) {
        if (entry.type === "directory" && !isHiddenOrGenerated(entry.name)) {
          const purpose = KNOWN_DIR_PURPOSES[entry.name] || null;
          if (purpose && !importantFolders.some((f) => f.name === entry.name)) {
            importantFolders.push({ name: `src/${entry.name}`, purpose });
            dirsToInspect.push(`src/${entry.name}`);
          }
        }
      }
    }
  }

  const dirsInspected = new Set<string>();
  const subdirEntries = new Map<string, Array<{ name: string; type: "file" | "directory" }>>();

  for (const dir of dirsToInspect.slice(0, MAX_SUBDIRS_INSPECTED)) {
    const entries = await safeListDir(runtime, dir);
    if (entries) {
      dirsInspected.add(dir);
      subdirEntries.set(dir, entries.slice(0, MAX_SUBDIR_ENTRIES));
    }
  }

  const entryPoint = detectEntryPoint(rootEntries, srcEntries);

  let supabaseLocation: string | null = null;
  const supabaseDirs = dirsToInspect.filter((d) => d.toLowerCase().includes("supabase"));
  if (supabaseDirs.length > 0) {
    supabaseLocation = supabaseDirs[0];
  } else {
    for (const [dir, entries] of subdirEntries) {
      for (const entry of entries) {
        if (SUPABASE_MARKERS.some((m) => entry.name.toLowerCase().includes(m.toLowerCase()))) {
          supabaseLocation = dir;
          break;
        }
      }
      if (supabaseLocation) break;
    }
  }

  let filesRead = 0;
  const readResults = new Map<string, string>();

  if (filesRead < MAX_FILES_READ) {
    const pkg = await safeReadFile(runtime, PACKAGE_JSON);
    if (pkg) {
      readResults.set(PACKAGE_JSON, pkg);
      filesRead++;
    }
  }

  for (const candidate of LAYOUT_CANDIDATES) {
    if (filesRead >= MAX_FILES_READ) break;
    if (!readResults.has(candidate)) {
      const content = await safeReadFile(runtime, candidate);
      if (content) {
        readResults.set(candidate, content);
        filesRead++;
      }
    }
  }

  for (const config of ROOT_CONFIG_FILES) {
    if (filesRead >= MAX_FILES_READ) break;
    if (!readResults.has(config)) {
      const content = await safeReadFile(runtime, config);
      if (content) {
        readResults.set(config, content);
        filesRead++;
      }
    }
  }

  if (!supabaseLocation) {
    for (const [filePath, content] of readResults) {
      if (SUPABASE_MARKERS.some((m) => content.includes(m))) {
        const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : ".";
        supabaseLocation = dir || ".";
        break;
      }
    }
  }

  const hasSrcApp = hasSrc && (srcEntries?.some((e) => e.name === "app") ?? false);
  const hasApp = rootFolders.includes("app") || hasSrcApp;
  const architecturePattern = detectArchitecture(rootEntries, hasSrc, hasApp, hasPages);

  const lines: string[] = [];
  lines.push("## Project Structure Inspection");
  lines.push("");

  lines.push("### Root Directory");
  lines.push("```");
  lines.push(rootFolders.filter((f) => !isHiddenOrGenerated(f)).map((f) => `${f}/`).join("\n"));
  if (rootFiles.length > 0) {
    lines.push(rootFiles.slice(0, 15).join("\n"));
    if (rootFiles.length > 15) lines.push(`... and ${rootFiles.length - 15} more files`);
  }
  lines.push("```");
  lines.push("");

  if (importantFolders.length > 0) {
    lines.push("### Important Directories");
    for (const folder of importantFolders) {
      const entries = subdirEntries.get(folder.name);
      const count = entries ? entries.length : "?";
      lines.push(`- **${folder.name}/** — ${folder.purpose} (${count} entries)`);
    }
    lines.push("");
  }

  if (entryPoint) {
    lines.push("### Entry Point");
    const verified = readResults.has(entryPoint) ? "verified" : "inferred";
    lines.push(`- **${entryPoint}** (${verified})`);
    lines.push("");
  }

  if (supabaseLocation) {
    lines.push("### Supabase Code");
    lines.push(`- Located in **${supabaseLocation}**`);
    lines.push("");
  } else {
    lines.push("### Supabase Code");
    lines.push("- No Supabase configuration or client code detected in workspace");
    lines.push("");
  }

  if (architecturePattern) {
    lines.push("### Architecture Pattern");
    lines.push(`- **${architecturePattern}** (verified from directory structure)`);
    lines.push("");
  }

  lines.push("### Summary");
  lines.push(`- Root folders: ${rootFolders.filter((f) => !isHiddenOrGenerated(f)).length}`);
  lines.push(`- Directories inspected: ${dirsInspected.size}`);
  lines.push(`- Files read: ${filesRead}`);
  lines.push(`- Entry point: ${entryPoint || "not detected"}`);
  lines.push(`- Supabase: ${supabaseLocation || "not detected"}`);
  lines.push(`- Architecture: ${architecturePattern || "not determined"}`);

  return {
    reply: lines.join("\n"),
    suggestions: [
      "Read a specific file to see its contents",
      "Show git status to see recent changes",
      "Inspect a specific directory for more detail",
    ],
  };
}
