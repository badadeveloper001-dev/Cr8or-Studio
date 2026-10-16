import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nextCli = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
const sourceFiles = [
  "src/lib/security/access-code.ts",
  "src/lib/security/command-authorization.ts",
  "src/lib/security/command-catalogue.ts",
  "src/lib/security/command-operation-store.ts",
  "src/lib/security/policy.ts",
  "src/lib/security/approvals.ts",
  "src/lib/agents/tools.ts",
  "src/lib/agents/types.ts",
  "src/lib/workspace/runtime.ts",
  "src/lib/security/owner-management.ts",
  "src/lib/security/session-store.ts",
  "src/lib/security/execution-context.ts",
  "src/lib/security/auth.ts",
  "src/lib/security/private-auth-mode.ts",
  "src/lib/security/private-auth-http.ts",
  "src/lib/security/audit.ts",
  "src/lib/security/secrets.ts",
  "src/lib/security/redaction.ts",
  "src/lib/config/feature-flags.ts",
  "src/lib/supabase/server.ts",
  "src/lib/workspace/shell.ts",
  "src/lib/db/prisma.ts",
];
const probes = [
  { module: "command-authorization", exportedFunction: "authorizeDevelopmentCommand" },
  { module: "command-operation-store", exportedFunction: "readCommandOperation" },
  { module: "access-code", exportedFunction: "hashAccessCode" },
  { module: "owner-management", exportedFunction: "provisionOwner" },
  { module: "execution-context", exportedFunction: "cancelExecutionAuthorization" },
];

async function checkProbe(temporaryRoot, probe) {
  const appRoot = join(temporaryRoot, probe.module);
  await mkdir(join(appRoot, "src/app"), { recursive: true });
  await symlink(join(repositoryRoot, "node_modules"), join(appRoot, "node_modules"), "dir");
  for (const file of sourceFiles) {
    const destination = join(appRoot, file);
    await mkdir(dirname(destination), { recursive: true });
    // Compile the real modules, without copying application configuration or .env files.
    await copyFile(join(repositoryRoot, file), destination);
  }
  await copyFile(join(repositoryRoot, "tsconfig.json"), join(appRoot, "tsconfig.json"));
  await writeFile(join(appRoot, "package.json"), JSON.stringify({
    name: `auth-client-boundary-${probe.module}`,
    private: true,
  }));
  // Keep compiler diagnostics in the CLI process instead of forwarding them through worker pipes.
  await writeFile(join(appRoot, "next.config.mjs"),
    "export default { experimental: { cpus: 1, webpackBuildWorker: false } };\n");
  await writeFile(join(appRoot, "src/app/layout.tsx"), `
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`);
  await writeFile(join(appRoot, "src/app/page.tsx"), `
"use client";

import { ${probe.exportedFunction} } from "@/lib/security/${probe.module}";

export default function BoundaryProbe() {
  // Keep the import live without invoking credential or database operations during a build.
  return <button onClick={() => { void ${probe.exportedFunction}(${probe.module === "execution-context" ? "undefined" : '"public-synthetic-boundary-probe-code"'}); }}>
    Boundary probe
  </button>;
}
`);

  const logPath = join(appRoot, "build-output.log");
  const log = await open(logPath, "w", 0o600);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [nextCli, "build"], {
        cwd: appRoot,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
        // File descriptors also work in environments that restrict child-process pipes.
        stdio: ["ignore", log.fd, log.fd],
        timeout: 120_000,
        killSignal: "SIGKILL",
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await log.close();
  }
  // A timeout, missing dependency, or unrelated build failure is never a passing result.
  if (result.code !== 1 || result.signal) {
    throw new Error("The Next.js client-boundary probe could not complete.");
  }
  const output = await readFile(logPath, "utf8");

  // Next 15 can describe this App Router rejection using legacy "pages/ directory"
  // wording. Require its actual server-only diagnostic and a trace to our use-client page.
  const boundaryDiagnostic = /needs ["']server-only["']\. That only works in a Server Component|["']server-only["'] cannot be imported from a Client Component module/;
  const importTrace = output.slice(output.indexOf("Import trace for requested module:"));
  if (!output.includes("Failed to compile.") || !boundaryDiagnostic.test(output) ||
      !importTrace.includes(`src/lib/security/${probe.module}.ts`) ||
      !importTrace.includes("src/app/page.tsx")) {
    throw new Error("Next.js did not reject the credential import at its server-only Client Component boundary.");
  }
  console.log(`PASS: Next.js rejects ${probe.module} in a Client Component (server-only).`);
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cr8or-auth-client-boundary-"));
  try {
    for (const probe of probes) await checkProbe(temporaryRoot, probe);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch {
  // Build output can include source excerpts. Report only a fixed, safe failure.
  throw new Error("Authentication client-boundary verification failed.");
}
