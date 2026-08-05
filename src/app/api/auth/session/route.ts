import { NextRequest, NextResponse } from "next/server";

import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { resolveAuthSession } from "@/lib/security/auth";

export async function GET(request: NextRequest) {
  return withRouteMetrics("api/auth/session", async (request: NextRequest, { requestId }) => {
    try {
      const authEnabled = isFeatureEnabled("authGuard");
      const session = await resolveAuthSession(request, authEnabled);
      return NextResponse.json(
        {
          ok: true,
          authEnabled,
          authenticated: Boolean(session?.authenticated),
          session,
        },
        { status: 200 },
      );
    } catch {
      return internalErrorResponse("Failed to resolve auth session.", requestId);
    }
  })(request);
}
