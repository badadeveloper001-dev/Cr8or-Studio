import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";
import { getPolicyProfile, getPolicyRules, setPolicyProfile } from "@/lib/security/policy";

const bodySchema = z.object({
  profile: z.enum(["strict", "balanced", "autonomous"]),
});

export async function GET(request: NextRequest) {
  return withRouteMetrics("api/security/policy:get", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, {
      route: "api/security/policy:get",
      minRole: "viewer",
      requestId,
    });
    if (!auth.ok) return auth.response;

    return NextResponse.json(
      {
        ok: true,
        profile: getPolicyProfile(),
        rules: getPolicyRules(),
      },
      { status: 200 },
    );
  })(request);
}

export async function POST(request: NextRequest) {
  return withRouteMetrics("api/security/policy:post", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, {
      route: "api/security/policy:post",
      minRole: "owner",
      requestId,
      requireWorkspaceOwnership: true,
    });
    if (!auth.ok) return auth.response;

    try {
      const raw = await request.json();
      const payload = bodySchema.parse(raw);
      const profile = setPolicyProfile(payload.profile);

      return NextResponse.json(
        {
          ok: true,
          profile,
          rules: getPolicyRules(),
        },
        { status: 200 },
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Invalid policy payload.",
          details: error.issues,
          requestId,
        });
      }
      return internalErrorResponse("Failed to update policy profile.", requestId);
    }
  })(request);
}
