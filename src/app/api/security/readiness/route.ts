import { NextRequest, NextResponse } from "next/server";

import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { getSecretReadiness } from "@/lib/security/secrets";

export async function GET(request: NextRequest) {
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
