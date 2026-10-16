import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";

import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { getSecretReadiness } from "@/lib/security/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  return withRouteMetrics("api/security/readiness", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, {
      route: "api/security/readiness",
      minRole: "viewer",
      requestId,
    });
    if (!auth.ok) {
      return auth.response;
    }

    return NextResponse.json(
      {
        ok: true,
        readiness: getSecretReadiness(),
      },
      { status: 200 },
    );
  })(request);
}

export const GET = withPrivateApiAuth(
  { route: "api/security/readiness:get", minRole: "viewer" },
  GETHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/security/readiness:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } }),
);
