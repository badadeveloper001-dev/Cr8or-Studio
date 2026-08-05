import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { decideApproval, listApprovals, requestApproval } from "@/lib/security/approvals";
import { authorizeRoute } from "@/lib/security/authorization";
import { RiskAction } from "@/lib/security/policy";

const requestSchema = z.object({
  action: z.enum(["files.write", "git.commit-push", "github.write", "deploy.vercel", "project.create", "project.clone"]),
  title: z.string().min(3).max(180),
  preview: z.string().min(3).max(6000),
});

const decideSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approved", "denied"]),
  reason: z.string().max(500).optional(),
});

const bodySchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("request"), payload: requestSchema }),
  z.object({ intent: z.literal("decide"), payload: decideSchema }),
]);

export async function GET(request: NextRequest) {
  return withRouteMetrics("api/security/approvals:get", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, {
      route: "api/security/approvals:get",
      minRole: "viewer",
      requestId,
    });
    if (!auth.ok) return auth.response;

    const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 500)) : 100;
    const records = listApprovals(limit);

    return NextResponse.json(
      {
        ok: true,
        approvals: records,
      },
      { status: 200 },
    );
  })(request);
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/security/approvals:post", async (request: NextRequest, { requestId }) => {
    try {
      const raw = await request.json();
      const body = bodySchema.parse(raw);

      if (body.intent === "request") {
        const auth = await authorizeRoute(request, {
          route: "api/security/approvals:request",
          minRole: "maintainer",
          requestId,
          requireWorkspaceOwnership: true,
        });
        if (!auth.ok) return auth.response;

        const record = requestApproval({
          action: body.payload.action as RiskAction,
          title: body.payload.title,
          preview: body.payload.preview,
          requestedBy: auth.session.userId,
          requestedRole: auth.session.role,
        });

        return NextResponse.json({ ok: true, approval: record }, { status: 201 });
      }

      const auth = await authorizeRoute(request, {
        route: "api/security/approvals:decide",
        minRole: "owner",
        requestId,
        requireWorkspaceOwnership: true,
      });
      if (!auth.ok) return auth.response;

      const record = decideApproval({
        id: body.payload.id,
        decision: body.payload.decision,
        reason: body.payload.reason,
        decidedBy: auth.session.userId,
        decidedRole: auth.session.role,
      });

      if (!record) {
        return errorResponse({
          status: 404,
          code: "NOT_FOUND",
          message: "Approval request not found.",
          requestId,
        });
      }

      return NextResponse.json({ ok: true, approval: record }, { status: 200 });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Invalid approval request payload.",
          details: error.issues,
          requestId,
        });
      }
      return internalErrorResponse("Approval workflow operation failed.", requestId);
    }
  })(request);
}
