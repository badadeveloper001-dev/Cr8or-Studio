import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { runSandboxedCommand, SandboxViolationError } from "@/lib/security/sandbox";
import { resolveWorkspacePath, sanitizeWorkspacePath, WORKSPACE_ROOT } from "@/lib/workspace/shell";

const bodySchema = z.object({
  action: z.enum(["status", "commit-push", "diff", "stage", "unstage"]),
  projectPath: z.string().default("."),
  message: z.string().optional(),
  filePath: z.string().optional(),
  dryRun: z.boolean().optional(),
  approvalId: z.string().uuid().optional(),
});

type GitChange = {
  path: string;
  status: string;
};

type CommitPushReceipt = {
  branch: string;
  headSha: string;
  remoteUrl: string;
  hadCommit: boolean;
};

function parseChanges(raw: string): GitChange[] {
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "?";
      const path = line.slice(3).trim();
      return { path, status };
    });
}

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

async function collectCommitPushReceipt(
  cwd: string,
  projectPath: string,
  actorId: string,
  actorRole: string,
  requestId: string,
): Promise<CommitPushReceipt> {
  const [branch, headSha, remote] = await Promise.all([
    runSandboxedCommand({
      command: "git branch --show-current",
      cwd,
      workspaceId: projectPath,
      route: "api/github/ops:commit-push",
      actorId,
      actorRole,
      requestId,
      allowedRoots: [cwd],
      allowedCommands: [{ kind: "exact", value: "git branch --show-current" }],
    }),
    runSandboxedCommand({
      command: "git rev-parse --short HEAD",
      cwd,
      workspaceId: projectPath,
      route: "api/github/ops:commit-push",
      actorId,
      actorRole,
      requestId,
      allowedRoots: [cwd],
      allowedCommands: [{ kind: "exact", value: "git rev-parse --short HEAD" }],
    }),
    runSandboxedCommand({
      command: "git remote get-url origin",
      cwd,
      workspaceId: projectPath,
      route: "api/github/ops:commit-push",
      actorId,
      actorRole,
      requestId,
      allowedRoots: [cwd],
      allowedCommands: [{ kind: "exact", value: "git remote get-url origin" }],
    }),
  ]);

  return {
    branch: branch.stdout,
    headSha: headSha.stdout,
    remoteUrl: remote.stdout,
    hadCommit: true,
  };
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/github/ops", async (request: NextRequest, { requestId }) => {
  try {
    const raw = await request.json();
    const payload = bodySchema.parse(raw);

    const minRole = payload.action === "status" || payload.action === "diff" ? "viewer" : payload.action === "commit-push" ? "owner" : "maintainer";
    const auth = await authorizeRoute(request, {
      route: "api/github/ops",
      minRole,
      requestId,
      requireWorkspaceOwnership: payload.action === "commit-push",
    });
    if (!auth.ok) {
      return auth.response;
    }

    const cwd = safeCwd(payload.projectPath);
    if (!cwd) {
      return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid project path.", requestId });
    }

    if (payload.action === "status") {
      const [branch, status, remote, tracking, recentCommits] = await Promise.all([
        runSandboxedCommand({
          command: "git branch --show-current",
          cwd,
          workspaceId: payload.projectPath,
          route: "api/github/ops:status",
          actorId: auth.session.userId,
          actorRole: auth.session.role,
          requestId,
          allowedRoots: [cwd],
          allowedCommands: [{ kind: "exact", value: "git branch --show-current" }],
        }),
        runSandboxedCommand({
          command: "git status --short",
          cwd,
          workspaceId: payload.projectPath,
          route: "api/github/ops:status",
          actorId: auth.session.userId,
          actorRole: auth.session.role,
          requestId,
          allowedRoots: [cwd],
          allowedCommands: [{ kind: "exact", value: "git status --short" }],
        }),
        runSandboxedCommand({
          command: "git remote -v",
          cwd,
          workspaceId: payload.projectPath,
          route: "api/github/ops:status",
          actorId: auth.session.userId,
          actorRole: auth.session.role,
          requestId,
          allowedRoots: [cwd],
          allowedCommands: [{ kind: "exact", value: "git remote -v" }],
        }),
        runSandboxedCommand({
          command: "git status --porcelain=2 --branch | head -n 2",
          cwd,
          workspaceId: payload.projectPath,
          route: "api/github/ops:status",
          actorId: auth.session.userId,
          actorRole: auth.session.role,
          requestId,
          allowedRoots: [cwd],
          allowedCommands: [{ kind: "exact", value: "git status --porcelain=2 --branch | head -n 2" }],
        }),
        runSandboxedCommand({
          command: "git --no-pager log --oneline -n 5",
          cwd,
          workspaceId: payload.projectPath,
          route: "api/github/ops:status",
          actorId: auth.session.userId,
          actorRole: auth.session.role,
          requestId,
          allowedRoots: [cwd],
          allowedCommands: [{ kind: "exact", value: "git --no-pager log --oneline -n 5" }],
        }),
      ]);

      const changeList = parseChanges(status.stdout);

      return NextResponse.json(
        {
          branch: branch.stdout,
          changes: status.stdout,
          changedFiles: changeList,
          changedCount: changeList.length,
          tracking: tracking.stdout,
          recentCommits: recentCommits.stdout,
          remotes: remote.stdout,
        },
        { status: 200 },
      );
    }

    if (payload.action === "diff") {
      if (!payload.filePath?.trim()) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "filePath is required for diff action.",
          requestId,
        });
      }

      const diff = await runSandboxedCommand({
        command: `git --no-pager diff -- ${JSON.stringify(payload.filePath.trim())}`,
        cwd,
        workspaceId: payload.projectPath,
        route: "api/github/ops:diff",
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        requestId,
        allowedRoots: [cwd],
        allowedCommands: [{ kind: "prefix", value: "git --no-pager diff -- " }],
      });

      const stagedDiff = await runSandboxedCommand({
        command: `git --no-pager diff --staged -- ${JSON.stringify(payload.filePath.trim())}`,
        cwd,
        workspaceId: payload.projectPath,
        route: "api/github/ops:diff",
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        requestId,
        allowedRoots: [cwd],
        allowedCommands: [{ kind: "prefix", value: "git --no-pager diff --staged -- " }],
      });

      return NextResponse.json(
        {
          filePath: payload.filePath.trim(),
          diff: diff.stdout,
          stagedDiff: stagedDiff.stdout,
        },
        { status: 200 },
      );
    }

    if (payload.action === "stage" || payload.action === "unstage") {
      if (!payload.filePath?.trim()) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "filePath is required.",
          requestId,
        });
      }

      const isStage = payload.action === "stage";
      const preview = {
        action: isStage ? "git.stage" : "git.unstage",
        cwd,
        filePath: payload.filePath.trim(),
        command: isStage
          ? `git add -- ${payload.filePath.trim()}`
          : `git restore --staged -- ${payload.filePath.trim()}`,
      };

      if (payload.dryRun) {
        return NextResponse.json({ dryRun: true, preview }, { status: 200 });
      }

      const policy = evaluatePolicyGuard({
        action: "files.write",
        requestId,
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        approvalId: payload.approvalId,
      });
      if (!policy.allowed) {
        return NextResponse.json(
          {
            ok: false,
            message: policy.reason,
            requiresApproval: policy.approvalRequired,
            policy: {
              profile: policy.profile,
              risk: policy.risk,
              action: "files.write",
            },
            preview,
          },
          { status: 409 },
        );
      }

      const result = await runSandboxedCommand({
        command: isStage
          ? `git add -- ${JSON.stringify(payload.filePath.trim())}`
          : `git restore --staged -- ${JSON.stringify(payload.filePath.trim())}`,
        cwd,
        workspaceId: payload.projectPath,
        route: `api/github/ops:${payload.action}`,
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        requestId,
        allowedRoots: [cwd],
        allowedCommands: [
          { kind: "prefix", value: "git add -- " },
          { kind: "prefix", value: "git restore --staged -- " },
        ],
      });

      return NextResponse.json(
        {
          action: payload.action,
          filePath: payload.filePath.trim(),
          output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        },
        { status: 200 },
      );
    }

    if (payload.action === "commit-push") {
      const commitMessage = payload.message?.trim() || "chore: update project via Cr8or Studio";
      const preview = {
        action: "git.commit-push",
        cwd,
        commands: ["git add -A", `git commit -m ${JSON.stringify(commitMessage)}`, "git push"],
      };

      if (payload.dryRun) {
        return NextResponse.json(
          {
            dryRun: true,
            preview,
          },
          { status: 200 },
        );
      }

      const policy = evaluatePolicyGuard({
        action: "git.commit-push",
        requestId,
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        approvalId: payload.approvalId,
      });
      if (!policy.allowed) {
        return NextResponse.json(
          {
            ok: false,
            message: policy.reason,
            requiresApproval: policy.approvalRequired,
            policy: {
              profile: policy.profile,
              risk: policy.risk,
              action: "git.commit-push",
            },
            preview,
          },
          { status: 409 },
        );
      }

      const add = await runSandboxedCommand({
        command: "git add -A",
        cwd,
        workspaceId: payload.projectPath,
        route: "api/github/ops:commit-push",
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        requestId,
        allowedRoots: [cwd],
        allowedCommands: [{ kind: "exact", value: "git add -A" }],
      });

      let commitOutput = "";
      try {
        const commit = await runSandboxedCommand({
          command: `git commit -m ${JSON.stringify(commitMessage)}`,
          cwd,
          workspaceId: payload.projectPath,
          route: "api/github/ops:commit-push",
          actorId: auth.session.userId,
          actorRole: auth.session.role,
          requestId,
          allowedRoots: [cwd],
          allowedCommands: [{ kind: "prefix", value: "git commit -m " }],
        });
        commitOutput = [commit.stdout, commit.stderr].filter(Boolean).join("\n");
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : "commit failed";
        if (!errMessage.toLowerCase().includes("nothing to commit")) {
          throw error;
        }
        commitOutput = "Nothing to commit.";
      }

      const push = await runSandboxedCommand({
        command: "git push",
        cwd,
        workspaceId: payload.projectPath,
        route: "api/github/ops:commit-push",
        actorId: auth.session.userId,
        actorRole: auth.session.role,
        requestId,
        allowedRoots: [cwd],
        allowedCommands: [{ kind: "exact", value: "git push" }],
      });

      const receipt = await collectCommitPushReceipt(
        cwd,
        payload.projectPath,
        auth.session.userId,
        auth.session.role,
        requestId,
      );

      if (commitOutput === "Nothing to commit.") {
        receipt.hadCommit = false;
      }

      return NextResponse.json(
        {
          staged: [add.stdout, add.stderr].filter(Boolean).join("\n"),
          commit: commitOutput,
          push: [push.stdout, push.stderr].filter(Boolean).join("\n"),
          receipt,
        },
        { status: 200 },
      );
    }

    return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Unsupported action.", requestId });
  } catch (error) {
    if (error instanceof SandboxViolationError) {
      return errorResponse({
        status: error.status,
        code: "FORBIDDEN",
        message: error.message,
        requestId,
      });
    }
    if (error instanceof z.ZodError) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Invalid request payload.",
        details: error.issues,
        requestId,
      });
    }
    return internalErrorResponse("GitHub operation failed.", requestId);
  }
  })(request);
}
