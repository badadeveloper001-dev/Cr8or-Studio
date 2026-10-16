import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";

import { getFeatureFlagDefinitions, getFeatureFlags, isFeatureEnabled } from "@/lib/config/feature-flags";
import { errorResponse } from "@/lib/http/api-response";
import { getSliSnapshot, withRouteMetrics } from "@/lib/observability/sli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  return withRouteMetrics("api/health/slis", async (_request: NextRequest, { requestId }) => {
  if (!isFeatureEnabled("sliEndpoint")) {
    return errorResponse({
      status: 404,
      code: "NOT_FOUND",
      message: "SLI endpoint disabled by feature flag.",
      requestId,
    });
  }

  return NextResponse.json(
    {
      ok: true,
      service: "cr8or-studio",
      flags: getFeatureFlags(),
      flagDefinitions: getFeatureFlagDefinitions(),
      sli: getSliSnapshot(),
    },
    { status: 200 },
  );
  })(request);
}

export const GET = withPrivateApiAuth(
  { route: "api/health/slis:get", minRole: "viewer" },
  GETHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/health/slis:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } }),
);
