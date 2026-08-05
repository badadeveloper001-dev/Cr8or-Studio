import { Buffer } from "node:buffer";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { isTransientHttpStatus, withRetry } from "@/lib/reliability/retry";
import { authorizeRoute } from "@/lib/security/authorization";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { getSecretWithFallback } from "@/lib/security/secrets";

const bodySchema = z.object({
  action: z.enum([
    "list-repos",
    "list-branches",
    "list-contents",
    "read-file",
    "upsert-file",
    "create-branch",
    "create-pr",
    "pr-checks",
  ]),
  owner: z.string().optional(),
  repo: z.string().optional(),
  path: z.string().optional(),
  ref: z.string().optional(),
  branch: z.string().optional(),
  newBranch: z.string().optional(),
  fromBranch: z.string().optional(),
  message: z.string().optional(),
  content: z.string().optional(),
  sha: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  head: z.string().optional(),
  base: z.string().optional(),
  pullNumber: z.number().int().positive().optional(),
  query: z.string().optional(),
  dryRun: z.boolean().optional(),
  approvalId: z.string().uuid().optional(),
});

async function githubRequest<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  return withRetry(
    async () => {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Cr8or-Studio",
          ...(init?.headers ?? {}),
        },
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`GitHub API ${response.status}: ${text.slice(0, 240)}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      return response.json() as Promise<T>;
    },
    {
      retries: 3,
      minDelayMs: 300,
      maxDelayMs: 2500,
      shouldRetry: (error) => {
        if (!(error instanceof Error)) return false;
        const status = (error as Error & { status?: number }).status;
        return typeof status === "number" ? isTransientHttpStatus(status) : true;
      },
    },
  );
}

function requireRepo(payload: z.infer<typeof bodySchema>) {
  if (!payload.owner || !payload.repo) {
    throw new Error("owner and repo are required for this action.");
  }
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/github/api", async (request: NextRequest, { requestId }) => {
  try {
    const token = getSecretWithFallback(["GITHUB_TOKEN", "GH_TOKEN"], requestId).value;
    if (!token) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Missing GITHUB_TOKEN (or GH_TOKEN).",
        requestId,
      });
    }

    const raw = await request.json();
    const payload = bodySchema.parse(raw);

    const writeActions = new Set(["upsert-file", "create-branch", "create-pr"]);
    const auth = await authorizeRoute(request, {
      route: "api/github/api",
      minRole: writeActions.has(payload.action) ? "owner" : "viewer",
      requestId,
      requireWorkspaceOwnership: writeActions.has(payload.action),
    });
    if (!auth.ok) {
      return auth.response;
    }

    if (writeActions.has(payload.action)) {
      const preview = {
        action: payload.action,
        owner: payload.owner,
        repo: payload.repo,
        path: payload.path,
        branch: payload.branch,
        base: payload.base,
        head: payload.head,
        title: payload.title,
      };

      if (payload.dryRun) {
        return NextResponse.json({ dryRun: true, preview }, { status: 200 });
      }

      const policy = evaluatePolicyGuard({
        action: "github.write",
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
              action: "github.write",
            },
            preview,
          },
          { status: 409 },
        );
      }
    }

    if (payload.action === "list-repos") {
      const repos = await githubRequest<Array<{
        id: number;
        name: string;
        full_name: string;
        private: boolean;
        default_branch: string;
        owner: { login: string };
      }>>(
        token,
        `https://api.github.com/user/repos?sort=updated&per_page=100`,
      );

      const query = payload.query?.trim().toLowerCase();
      const filtered = query
        ? repos.filter((repo) => repo.full_name.toLowerCase().includes(query))
        : repos;

      return NextResponse.json(
        {
          repos: filtered.map((repo) => ({
            id: repo.id,
            name: repo.name,
            fullName: repo.full_name,
            owner: repo.owner.login,
            private: repo.private,
            defaultBranch: repo.default_branch,
          })),
        },
        { status: 200 },
      );
    }

    requireRepo(payload);
    const owner = payload.owner as string;
    const repo = payload.repo as string;

    if (payload.action === "list-branches") {
      const branches = await githubRequest<Array<{ name: string; commit: { sha: string } }>>(
        token,
        `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
      );

      const details = await githubRequest<{ default_branch: string }>(
        token,
        `https://api.github.com/repos/${owner}/${repo}`,
      );

      return NextResponse.json(
        {
          defaultBranch: details.default_branch,
          branches: branches.map((branch) => ({ name: branch.name, sha: branch.commit.sha })),
        },
        { status: 200 },
      );
    }

    if (payload.action === "list-contents") {
      const targetPath = payload.path?.trim() || "";
      const ref = payload.ref?.trim();
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${targetPath}`);
      if (ref) url.searchParams.set("ref", ref);

      const content = await githubRequest<
        Array<{ type: string; name: string; path: string; sha: string }> | { type: string; name: string; path: string; sha: string }
      >(token, url.toString());

      const items = Array.isArray(content) ? content : [content];
      return NextResponse.json(
        {
          items: items.map((item) => ({
            type: item.type,
            name: item.name,
            path: item.path,
            sha: item.sha,
          })),
        },
        { status: 200 },
      );
    }

    if (payload.action === "read-file") {
      if (!payload.path) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "path is required.", requestId });
      }

      const ref = payload.ref?.trim();
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${payload.path}`);
      if (ref) url.searchParams.set("ref", ref);

      const file = await githubRequest<{
        type: string;
        name: string;
        path: string;
        sha: string;
        content?: string;
        encoding?: string;
      }>(token, url.toString());

      if (file.type !== "file") {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Target path is not a file.",
          requestId,
        });
      }

      const decoded = file.content && file.encoding === "base64"
        ? Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8")
        : "";

      return NextResponse.json(
        {
          name: file.name,
          path: file.path,
          sha: file.sha,
          content: decoded,
        },
        { status: 200 },
      );
    }

    if (payload.action === "upsert-file") {
      if (!payload.path || typeof payload.content !== "string" || !payload.message || !payload.branch) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "path, content, message, and branch are required.",
          requestId,
        });
      }

      const encoded = Buffer.from(payload.content, "utf8").toString("base64");
      const response = await githubRequest<{ content: { sha: string }; commit: { sha: string; html_url: string } }>(
        token,
        `https://api.github.com/repos/${owner}/${repo}/contents/${payload.path}`,
        {
          method: "PUT",
          body: JSON.stringify({
            message: payload.message,
            content: encoded,
            branch: payload.branch,
            sha: payload.sha,
          }),
        },
      );

      return NextResponse.json(
        {
          contentSha: response.content.sha,
          commitSha: response.commit.sha,
          commitUrl: response.commit.html_url,
        },
        { status: 200 },
      );
    }

    if (payload.action === "create-branch") {
      if (!payload.newBranch || !payload.fromBranch) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "newBranch and fromBranch are required.",
          requestId,
        });
      }

      const baseRef = await githubRequest<{ object: { sha: string } }>(
        token,
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${payload.fromBranch}`,
      );

      const created = await githubRequest<{ ref: string; object: { sha: string } }>(
        token,
        `https://api.github.com/repos/${owner}/${repo}/git/refs`,
        {
          method: "POST",
          body: JSON.stringify({
            ref: `refs/heads/${payload.newBranch}`,
            sha: baseRef.object.sha,
          }),
        },
      );

      return NextResponse.json(
        {
          ref: created.ref,
          sha: created.object.sha,
        },
        { status: 201 },
      );
    }

    if (payload.action === "create-pr") {
      if (!payload.title || !payload.head || !payload.base) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "title, head, and base are required.",
          requestId,
        });
      }

      const pr = await githubRequest<{ number: number; html_url: string; state: string }>(
        token,
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          method: "POST",
          body: JSON.stringify({
            title: payload.title,
            body: payload.body || "",
            head: payload.head,
            base: payload.base,
          }),
        },
      );

      return NextResponse.json(
        {
          number: pr.number,
          url: pr.html_url,
          state: pr.state,
        },
        { status: 201 },
      );
    }

    if (payload.action === "pr-checks") {
      if (!payload.pullNumber) {
        return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "pullNumber is required.", requestId });
      }

      const pr = await githubRequest<{ head: { sha: string }; state: string }>(
        token,
        `https://api.github.com/repos/${owner}/${repo}/pulls/${payload.pullNumber}`,
      );

      const [checks, status] = await Promise.all([
        githubRequest<{ total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }> }>(
          token,
          `https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
        ),
        githubRequest<{ state: string; statuses: Array<{ context: string; state: string; target_url: string | null }> }>(
          token,
          `https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/status`,
        ),
      ]);

      return NextResponse.json(
        {
          headSha: pr.head.sha,
          prState: pr.state,
          checkRuns: checks.check_runs,
          combinedStatus: status.state,
          statuses: status.statuses,
        },
        { status: 200 },
      );
    }

    return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Unsupported action.", requestId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Invalid request payload.",
        details: error.issues,
        requestId,
      });
    }

    return internalErrorResponse(
      error instanceof Error ? error.message : "GitHub API operation failed.",
      requestId,
    );
  }
  })(request);
}
