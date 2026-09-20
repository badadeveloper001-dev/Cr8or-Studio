import type { WorkspaceRuntime } from "@/lib/workspace/runtime";

const MAX_ACTIONS = 8;
const MAX_FILE_READS = 5;
const MAX_ENTRIES_PER_DIR = 40;

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

const ENV_READINESS_MARKERS = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "DAYTONA_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "VERCEL_TOKEN",
];

type CoverageItem = "mainFolders" | "folderPurpose" | "entryPoint" | "supabaseLocation" | "architecturePattern";

interface CoverageTracker {
  items: Record<CoverageItem, "pending" | "completed">;
  allCompleted(): boolean;
  markCompleted(item: CoverageItem): void;
  getPending(): CoverageItem[];
}

function createCoverageTracker(): CoverageTracker {
  const items: Record<CoverageItem, "pending" | "completed"> = {
    mainFolders: "pending",
    folderPurpose: "pending",
    entryPoint: "pending",
    supabaseLocation: "pending",
    architecturePattern: "pending",
  };
  return {
    items,
    allCompleted: () => Object.values(items).every((v) => v === "completed"),
    markCompleted: (item) => { items[item] = "completed"; },
    getPending: () => (Object.entries(items) as [CoverageItem, string][])
      .filter(([, v]) => v === "pending")
      .map(([k]) => k),
  };
}

interface InspectionContext {
  runtime: WorkspaceRuntime;
  actionsTaken: number;
  filesRead: number;
  depth: number;
  visitedDirs: Set<string>;
  readFileContents: Map<string, string>;
  dirEntries: Map<string, Array<{ name: string; type: "file" | "directory" }>>;
  coverage: CoverageTracker;
  rootFolders: string[];
  rootFiles: string[];
  srcEntries: Array<{ name: string; type: "file" | "directory" }> | null;
  hasApp: boolean;
  hasPages: boolean;
  hasSrc: boolean;
  importantFolders: Array<{ name: string; purpose: string }>;
  entryPoint: string | null;
  supabaseLocation: string | null;
  architecturePattern: string | null;
}

function isHiddenOrGenerated(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === ".next" || name === "dist" || name === "build" || name === ".vercel" || name === ".git";
}

async function safeReadFile(ctx: InspectionContext, filePath: string): Promise<string | null> {
  if (ctx.actionsTaken >= MAX_ACTIONS || ctx.filesRead >= MAX_FILE_READS) return null;
  try {
    const result = await ctx.runtime.readFile(filePath);
    ctx.actionsTaken++;
    ctx.filesRead++;
    ctx.readFileContents.set(filePath, result.content);
    return result.content;
  } catch {
    return null;
  }
}

async function safeListDir(ctx: InspectionContext, dirPath: string): Promise<Array<{ name: string; type: "file" | "directory" }> | null> {
  if (ctx.actionsTaken >= MAX_ACTIONS || ctx.visitedDirs.has(dirPath)) return null;
  try {
    const entries = await ctx.runtime.listFiles(dirPath);
    ctx.actionsTaken++;
    ctx.visitedDirs.add(dirPath);
    ctx.dirEntries.set(dirPath, entries.slice(0, MAX_ENTRIES_PER_DIR));
    return entries;
  } catch {
    return null;
  }
}

function detectEntryPoint(ctx: InspectionContext): string | null {
  if (ctx.hasSrc && ctx.srcEntries) {
    const hasSrcApp = ctx.srcEntries.some((e) => e.name === "app" && e.type === "directory");
    if (hasSrcApp) return "src/app/page.tsx";
    return "src/app/page.tsx";
  }
  if (ctx.hasApp) return "app/page.tsx";
  if (ctx.hasPages) return "pages/index.tsx";
  return null;
}

function detectArchitecture(ctx: InspectionContext): string | null {
  if (ctx.hasApp && ctx.hasSrc) return "Next.js App Router (src/app/)";
  if (ctx.hasApp) return "Next.js App Router";
  if (ctx.hasPages) return "Next.js Pages Router";
  return null;
}

function detectSupabaseFromContent(ctx: InspectionContext): string | null {
  for (const [filePath, content] of ctx.readFileContents) {
    if (SUPABASE_MARKERS.some((m) => content.includes(m))) {
      const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : ".";
      return dir || ".";
    }
  }
  return null;
}

function detectSupabaseFromEntries(ctx: InspectionContext): string | null {
  for (const [dir, entries] of ctx.dirEntries) {
    for (const entry of entries) {
      if (SUPABASE_MARKERS.some((m) => entry.name.toLowerCase().includes(m.toLowerCase()))) {
        return dir;
      }
    }
  }
  return null;
}

async function initializeContext(runtime: WorkspaceRuntime): Promise<InspectionContext> {
  const ctx: InspectionContext = {
    runtime,
    actionsTaken: 0,
    filesRead: 0,
    depth: 0,
    visitedDirs: new Set(),
    readFileContents: new Map(),
    dirEntries: new Map(),
    coverage: createCoverageTracker(),
    rootFolders: [],
    rootFiles: [],
    srcEntries: null,
    hasApp: false,
    hasPages: false,
    hasSrc: false,
    importantFolders: [],
    entryPoint: null,
    supabaseLocation: null,
    architecturePattern: null,
  };

  const rootEntries = await safeListDir(ctx, ".");
  if (!rootEntries || rootEntries.length === 0) return ctx;

  for (const entry of rootEntries) {
    if (entry.type === "directory") {
      ctx.rootFolders.push(entry.name);
    } else {
      ctx.rootFiles.push(entry.name);
    }
  }

  ctx.hasSrc = ctx.rootFolders.includes("src");
  ctx.hasPages = ctx.rootFolders.includes("pages");

  for (const name of ctx.rootFolders) {
    if (isHiddenOrGenerated(name)) continue;
    const purpose = KNOWN_DIR_PURPOSES[name] || null;
    if (purpose) {
      ctx.importantFolders.push({ name, purpose });
    }
  }

  if (ctx.hasSrc) {
    ctx.srcEntries = await safeListDir(ctx, "src");
    if (ctx.srcEntries) {
      for (const entry of ctx.srcEntries) {
        if (entry.type === "directory" && !isHiddenOrGenerated(entry.name)) {
          const purpose = KNOWN_DIR_PURPOSES[entry.name] || null;
          if (purpose && !ctx.importantFolders.some((f) => f.name === entry.name)) {
            ctx.importantFolders.push({ name: `src/${entry.name}`, purpose });
          }
        }
      }
    }
  }

  ctx.hasApp = ctx.rootFolders.includes("app") || (ctx.hasSrc && (ctx.srcEntries?.some((e) => e.name === "app") ?? false));
  ctx.entryPoint = detectEntryPoint(ctx);
  ctx.architecturePattern = detectArchitecture(ctx);

  return ctx;
}

function shouldReadPackageJson(ctx: InspectionContext): boolean {
  return !ctx.readFileContents.has("package.json") && ctx.filesRead < MAX_FILE_READS;
}

function shouldReadLayoutFiles(ctx: InspectionContext): boolean {
  return LAYOUT_CANDIDATES.some((c) => !ctx.readFileContents.has(c)) && ctx.filesRead < MAX_FILE_READS;
}

function shouldReadConfigFiles(ctx: InspectionContext): boolean {
  return ROOT_CONFIG_FILES.some((c) => !ctx.readFileContents.has(c)) && ctx.filesRead < MAX_FILE_READS;
}

function shouldInspectSubdirs(ctx: InspectionContext): boolean {
  return ctx.importantFolders.some((f) => !ctx.visitedDirs.has(f.name)) && ctx.actionsTaken < MAX_ACTIONS;
}

async function executeNextAction(ctx: InspectionContext): Promise<boolean> {
  if (ctx.actionsTaken >= MAX_ACTIONS || ctx.filesRead >= MAX_FILE_READS) return false;

  if (shouldReadPackageJson(ctx)) {
    await safeReadFile(ctx, "package.json");
    return true;
  }

  if (shouldInspectSubdirs(ctx)) {
    for (const folder of ctx.importantFolders) {
      if (!ctx.visitedDirs.has(folder.name) && ctx.actionsTaken < MAX_ACTIONS) {
        await safeListDir(ctx, folder.name);
      }
    }
    return true;
  }

  if (shouldReadLayoutFiles(ctx)) {
    for (const candidate of LAYOUT_CANDIDATES) {
      if (!ctx.readFileContents.has(candidate) && ctx.filesRead < MAX_FILE_READS) {
        const content = await safeReadFile(ctx, candidate);
        if (content) break;
      }
    }
    return true;
  }

  if (shouldReadConfigFiles(ctx)) {
    for (const config of ROOT_CONFIG_FILES) {
      if (!ctx.readFileContents.has(config) && ctx.filesRead < MAX_FILE_READS) {
        await safeReadFile(ctx, config);
      }
    }
    return true;
  }

  return false;
}

function updateCoverage(ctx: InspectionContext): void {
  if (ctx.rootFolders.length > 0) ctx.coverage.markCompleted("mainFolders");
  if (ctx.importantFolders.length > 0) ctx.coverage.markCompleted("folderPurpose");
  if (ctx.entryPoint) ctx.coverage.markCompleted("entryPoint");
  if (ctx.supabaseLocation) ctx.coverage.markCompleted("supabaseLocation");
  if (ctx.architecturePattern) ctx.coverage.markCompleted("architecturePattern");
}

function buildReply(ctx: InspectionContext): string {
  const lines: string[] = [];
  lines.push("## Project Structure Inspection");
  lines.push("");

  lines.push("### Root Directory");
  lines.push("```");
  lines.push(ctx.rootFolders.filter((f) => !isHiddenOrGenerated(f)).map((f) => `${f}/`).join("\n"));
  if (ctx.rootFiles.length > 0) {
    lines.push(ctx.rootFiles.slice(0, 15).join("\n"));
    if (ctx.rootFiles.length > 15) lines.push(`... and ${ctx.rootFiles.length - 15} more files`);
  }
  lines.push("```");
  lines.push("");

  const pkgContent = ctx.readFileContents.get("package.json");
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent) as { name?: string; version?: string; scripts?: Record<string, string> };
      if (pkg.name) {
        lines.push("### Project Info");
        const version = pkg.version ? ` (version ${pkg.version})` : "";
        lines.push(`- **Name**: \`${pkg.name}\`${version}`);
        if (pkg.scripts) {
          const scriptNames = Object.keys(pkg.scripts);
          if (scriptNames.length > 0) {
            lines.push(`- **Scripts**: ${scriptNames.join(", ")}`);
          }
        }
        lines.push("");
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (ctx.importantFolders.length > 0) {
    lines.push("### Important Directories");
    for (const folder of ctx.importantFolders) {
      const entries = ctx.dirEntries.get(folder.name);
      const count = entries ? entries.length : "?";
      lines.push(`- **${folder.name}/** — ${folder.purpose} (${count} entries)`);
    }
    lines.push("");
  }

  if (ctx.entryPoint) {
    lines.push("### Entry Point");
    const verified = ctx.readFileContents.has(ctx.entryPoint) ? "verified" : "inferred";
    lines.push(`- **${ctx.entryPoint}** (${verified})`);
    lines.push("");
  }

  if (ctx.supabaseLocation) {
    lines.push("### Supabase Code");
    lines.push(`- Located in **${ctx.supabaseLocation}**`);
    lines.push("");
  } else {
    lines.push("### Supabase Code");
    lines.push("- No Supabase configuration or client code detected in workspace");
    lines.push("");
  }

  if (ctx.architecturePattern) {
    lines.push("### Architecture Pattern");
    lines.push(`- **${ctx.architecturePattern}** (verified from directory structure)`);
    lines.push("");
  }

  const pending = ctx.coverage.getPending();
  if (pending.length > 0) {
    lines.push("### Limitations");
    lines.push(`- Could not verify: ${pending.join(", ")}`);
    lines.push("");
  }

  lines.push("### Summary");
  lines.push(`- Root folders: ${ctx.rootFolders.filter((f) => !isHiddenOrGenerated(f)).length}`);
  lines.push(`- Directories inspected: ${ctx.visitedDirs.size}`);
  lines.push(`- Files read: ${ctx.filesRead}`);
  lines.push(`- Entry point: ${ctx.entryPoint || "not detected"}`);
  lines.push(`- Supabase: ${ctx.supabaseLocation || "not detected"}`);
  lines.push(`- Architecture: ${ctx.architecturePattern || "not determined"}`);
  lines.push(`- Actions taken: ${ctx.actionsTaken}/${MAX_ACTIONS}`);

  return lines.join("\n");
}

export async function performReadOnlyTaskLoop(
  runtime: WorkspaceRuntime,
): Promise<{ reply: string; suggestions: string[] }> {
  const ctx = await initializeContext(runtime);

  if (ctx.rootFolders.length === 0 && ctx.rootFiles.length === 0) {
    return {
      reply: "The workspace root is empty or inaccessible.",
      suggestions: ["Check workspace status in the activity panel"],
    };
  }

  ctx.supabaseLocation = detectSupabaseFromEntries(ctx) || detectSupabaseFromContent(ctx);
  updateCoverage(ctx);

  let iterations = 0;
  while (iterations < MAX_ACTIONS && ctx.actionsTaken < MAX_ACTIONS && !ctx.coverage.allCompleted()) {
    const didWork = await executeNextAction(ctx);
    if (!didWork) break;

    ctx.supabaseLocation = ctx.supabaseLocation || detectSupabaseFromEntries(ctx) || detectSupabaseFromContent(ctx);
    updateCoverage(ctx);
    iterations++;
  }

  return {
    reply: buildReply(ctx),
    suggestions: [
      "Read a specific file to see its contents",
      "Show git status to see recent changes",
      "Inspect a specific directory for more detail",
    ],
  };
}

async function safeReadFileForReadiness(runtime: WorkspaceRuntime, filePath: string): Promise<string | null> {
  try {
    const result = await runtime.readFile(filePath);
    return result.content;
  } catch {
    return null;
  }
}

async function safeListDirForReadiness(runtime: WorkspaceRuntime, dirPath: string): Promise<Array<{ name: string; type: "file" | "directory" }> | null> {
  try {
    return await runtime.listFiles(dirPath);
  } catch {
    return null;
  }
}

function analyzeReadiness(rootEntries: Array<{ name: string; type: "file" | "directory" }>, pkgContent: string | null, envExample: string | null, configContent: string | null): { ready: boolean; issues: string[]; verified: string[] } {
  const issues: string[] = [];
  const verified: string[] = [];

  const hasPackageJson = rootEntries.some((e) => e.name === "package.json");
  if (hasPackageJson) verified.push("package.json present");
  else issues.push("Missing package.json");

  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent) as { scripts?: Record<string, string>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      if (pkg.scripts?.dev) verified.push("dev script available");
      else if (pkg.scripts?.start) verified.push("start script available (no dev script)");
      else issues.push("No dev or start script in package.json");

      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps) {
        const hasFramework = Object.keys(deps).some((k) => k.includes("next") || k.includes("react") || k.includes("vue") || k.includes("svelte"));
        if (hasFramework) verified.push("framework dependency detected");
        else issues.push("No framework dependency found");
      }
    } catch {
      issues.push("package.json is not valid JSON");
    }
  }

  if (envExample) {
    verified.push(".env.example found");
    const missingEnvVars = ENV_READINESS_MARKERS.filter((marker) => envExample.includes(marker));
    if (missingEnvVars.length > 0) {
      issues.push(`Environment variables needed: ${missingEnvVars.join(", ")}`);
    }
  } else {
    issues.push("No .env.example file found");
  }

  if (configContent) {
    verified.push("Configuration file found");
  }

  const hasLockfile = rootEntries.some((e) => e.name === "package-lock.json" || e.name === "yarn.lock" || e.name === "pnpm-lock.yaml" || e.name === "bun.lockb");
  if (hasLockfile) verified.push("lockfile present");
  else issues.push("No lockfile found (run npm install first)");

  return { ready: issues.length === 0, issues, verified };
}

export async function performLocalReadinessCheck(
  runtime: WorkspaceRuntime,
): Promise<{ reply: string; suggestions: string[] }> {
  const rootEntries = await safeListDirForReadiness(runtime, ".");
  if (!rootEntries || rootEntries.length === 0) {
    return {
      reply: "The workspace root is empty or inaccessible. Cannot assess local readiness.",
      suggestions: ["Check workspace status in the activity panel"],
    };
  }

  const pkgContent = await safeReadFileForReadiness(runtime, "package.json");
  const envExample = await safeReadFileForReadiness(runtime, ".env.example");
  const configContent = await safeReadFileForReadiness(runtime, "next.config.js")
    || await safeReadFileForReadiness(runtime, "next.config.mjs")
    || await safeReadFileForReadiness(runtime, "next.config.ts");

  const { ready, issues, verified } = analyzeReadiness(rootEntries, pkgContent, envExample, configContent);

  const lines: string[] = [];
  lines.push("## Local Readiness Assessment");
  lines.push("");

  if (ready) {
    lines.push("**Status: Ready to run locally**");
  } else {
    lines.push("**Status: Not ready — action required**");
  }
  lines.push("");

  if (verified.length > 0) {
    lines.push("### Verified");
    for (const item of verified) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (issues.length > 0) {
    lines.push("### Issues");
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }

  lines.push("### Next Steps");
  if (!ready) {
    lines.push("1. Fix the issues listed above");
    lines.push("2. Run `npm install` to install dependencies");
    lines.push("3. Create a `.env` file based on `.env.example`");
    lines.push("4. Run `npm run dev` to start the development server");
  } else {
    lines.push("1. Run `npm install` to install dependencies");
    lines.push("2. Create a `.env` file based on `.env.example`");
    lines.push("3. Run `npm run dev` to start the development server");
  }

  return {
    reply: lines.join("\n"),
    suggestions: [
      "Run npm install to install dependencies",
      "Create a .env file from .env.example",
      "Start the development server",
    ],
  };
}
