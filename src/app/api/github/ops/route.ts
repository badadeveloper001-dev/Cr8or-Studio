import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { resolveWorkspacePath, runShell, sanitizeWorkspacePath, WORKSPACE_ROOT } from "@/lib/workspace/shell";

const bodySchema = z.object({
  action: z.enum(["status", "commit-push"]),
  projectPath: z.string().default("."),
  message: z.string().optional(),
});

function safeCwd(projectPath: string): string | null {
  const safePath = sanitizeWorkspacePath(projectPath === "." ? "" : projectPath);
  if (projectPath === ".") {
    return WORKSPACE_ROOT;
  }

  if (!safePath) {
    return null;
  }

  return resolveWorkspacePath(safePath);
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    const payload = bodySchema.parse(raw);

    const cwd = safeCwd(payload.projectPath);
    if (!cwd) {
      return NextResponse.json({ message: "Invalid project path." }, { status: 400 });
    }

    if (payload.action === "status") {
      const [branch, status, remote] = await Promise.all([
        runShell("git branch --show-current", cwd),
        runShell("git status --short", cwd),
        runShell("git remote -v", cwd),
      ]);

      return NextResponse.json(
        {
          branch: branch.stdout,
          changes: status.stdout,
          remotes: remote.stdout,
        },
        { status: 200 },
      );
    }

    if (payload.action === "commit-push") {
      const commitMessage = payload.message?.trim() || "chore: update project via Cr8or Studio";
      const add = await runShell("git add -A", cwd);

      let commitOutput = "";
      try {
        const commit = await runShell(`git commit -m ${JSON.stringify(commitMessage)}`, cwd);
        commitOutput = [commit.stdout, commit.stderr].filter(Boolean).join("\n");
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : "commit failed";
        if (!errMessage.toLowerCase().includes("nothing to commit")) {
          throw error;
        }
        commitOutput = "Nothing to commit.";
      }

      const push = await runShell("git push", cwd);

      return NextResponse.json(
        {
          staged: [add.stdout, add.stderr].filter(Boolean).join("\n"),
          commit: commitOutput,
          push: [push.stdout, push.stderr].filter(Boolean).join("\n"),
        },
        { status: 200 },
      );
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: "Invalid request payload.", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ message: "GitHub operation failed." }, { status: 500 });
  }
}
