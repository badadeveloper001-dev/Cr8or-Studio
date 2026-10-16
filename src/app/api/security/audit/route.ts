import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";

import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { errorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { getAuditEvents } from "@/lib/security/audit";
import { authorizeRoute } from "@/lib/security/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  return withRouteMetrics("api/security/audit", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, {
      route: "api/security/audit",
      minRole: "owner",
      requestId,
    });

    if (!auth.ok) {
      return auth.response;
    }

    if (!isFeatureEnabled("auditLog")) {
      return errorResponse({
        status: 404,
        code: "NOT_FOUND",
        message: "Audit logging feature is disabled.",
        requestId,
      });
    }

    const limitParam = request.nextUrl.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : 100;

    return NextResponse.json(
      {
        ok: true,
        events: getAuditEvents(Number.isFinite(limit) ? limit : 100),
      },
      { status: 200 },
    );
  })(request);
}

export const GET = withPrivateApiAuth(
  { route: "api/security/audit:get", minRole: "viewer" },
  GETHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/security/audit:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } }),
);
