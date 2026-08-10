import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";

import { NextRequest, NextResponse } from "next/server";
import { resolveWorkspacePath, sanitizeWorkspacePath } from "@/lib/workspace/shell";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { evaluatePolicyGuard } from "@/lib/security/policy";

export async function GET(request: NextRequest) {
  return withRouteMetrics("api/files:get", async (request: NextRequest, { requestId }) => {
  const auth = await authorizeRoute(request, { route: "api/files:get", minRole: "viewer", requestId });
  if (!auth.ok) {
    return auth.response;
  }

  if (process.env.VERCEL_ENV) {
    return errorResponse({
      status: 409,
      code: "CONFLICT",
      message: "Local workspace files are unavailable in the deployed app. Use the GitHub panel for repository browsing, or run Cr8or Studio locally for direct file access.",
      requestId,
    });
  }

  const relPath = request.nextUrl.searchParams.get("path") ?? "";
  const safePath = sanitizeWorkspacePath(relPath);

  if (!safePath) {
    return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid file path.", requestId });
  }

  const absolutePath = resolveWorkspacePath(safePath);
  if (!absolutePath) {
    return errorResponse({ status: 400, code: "FORBIDDEN", message: "Path is outside workspace.", requestId });
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Path is not a file.", requestId });
    }

    const content = await fs.readFile(absolutePath, "utf8");
    return NextResponse.json({ path: safePath, content }, { status: 200 });
  } catch {
    return errorResponse({ status: 404, code: "NOT_FOUND", message: "File not found or unreadable.", requestId });
  }
  })(request);
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/files:post", async (request: NextRequest, { requestId }) => {
  const auth = await authorizeRoute(request, {
    route: "api/files:post",
    minRole: "maintainer",
    requestId,
    requireWorkspaceOwnership: true,
  });
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const payload = (await request.json()) as {
      path?: string;
      content?: string;
      dryRun?: boolean;
      approvalId?: string;
    };
    const safePath = sanitizeWorkspacePath(payload.path ?? "");

    if (!safePath || typeof payload.content !== "string") {
      return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid file write payload.", requestId });
    }

    const absolutePath = resolveWorkspacePath(safePath);
    if (!absolutePath) {
      return errorResponse({ status: 400, code: "FORBIDDEN", message: "Path is outside workspace.", requestId });
    }

    const preview = {
      action: "files.write",
      path: safePath,
      bytes: Buffer.byteLength(payload.content, "utf8"),
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

    await fs.writeFile(absolutePath, payload.content, "utf8");
    return NextResponse.json({ path: safePath, saved: true }, { status: 200 });
  } catch {
    return internalErrorResponse("Failed to save file.", requestId);
  }
  })(request);
}
