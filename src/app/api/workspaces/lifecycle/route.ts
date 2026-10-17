import type { NextRequest } from "next/server";
import { withPrivateApiAuth } from "@/lib/security/private-api";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import { authError } from "@/lib/security/private-auth-http";
import { handlePrivateWorkspaceLifecycle } from "@/lib/security/private-lifecycle-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withPrivateApiAuth(
  { route: "api/workspaces/lifecycle:post", minRole: "owner" },
  (request: NextRequest) => handlePrivateWorkspaceLifecycle(request),
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/workspaces/lifecycle:options", minRole: "owner" },
  async () => getPrivateAuthMode() === "inactive"
    ? authError(503, "Workspace lifecycle is unavailable.")
    : new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST", "Cache-Control": "no-store" } }),
);
