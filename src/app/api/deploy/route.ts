import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { resolveWorkspacePath, runShell, sanitizeWorkspacePath, WORKSPACE_ROOT } from "@/lib/workspace/shell";

const bodySchema = z.object({
  projectPath: z.string().default("."),
  strategy: z.enum(["build-only", "vercel"]).default("build-only"),
});

function resolveCwd(projectPath: string): string | null {
  if (projectPath === ".") {
    return WORKSPACE_ROOT;
  }

  const safe = sanitizeWorkspacePath(projectPath);
  if (!safe) {
    return null;
  }

  return resolveWorkspacePath(safe);
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    const payload = bodySchema.parse(raw);

    const cwd = resolveCwd(payload.projectPath);
    if (!cwd) {
      return NextResponse.json({ message: "Invalid project path." }, { status: 400 });
    }

    const logs: string[] = [];
    const build = await runShell("npm run build", cwd);
    logs.push("Build complete.");
    if (build.stdout) logs.push(build.stdout);
    if (build.stderr) logs.push(build.stderr);

    if (payload.strategy === "vercel") {
      const token = process.env.VERCEL_TOKEN;
      if (!token) {
        return NextResponse.json({ message: "Missing VERCEL_TOKEN for deployment." }, { status: 400 });
      }

      const deploy = await runShell(`npx vercel --prod --yes --token ${token}`, cwd);
      logs.push("Vercel deploy complete.");
      if (deploy.stdout) logs.push(deploy.stdout);
      if (deploy.stderr) logs.push(deploy.stderr);
    }

    return NextResponse.json({ success: true, logs: logs.join("\n") }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: "Invalid deploy request.", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ message: "Deploy operation failed." }, { status: 500 });
  }
}
