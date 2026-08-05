import { NextRequest, NextResponse } from "next/server";

import { getFeatureFlagDefinitions, getFeatureFlags, isFeatureEnabled } from "@/lib/config/feature-flags";
import { errorResponse } from "@/lib/http/api-response";
import { getSliSnapshot, withRouteMetrics } from "@/lib/observability/sli";

export async function GET(request: NextRequest) {
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
