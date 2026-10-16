import { NextRequest, NextResponse } from "next/server";

import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { authorizeRoute } from "@/lib/security/authorization";
import { authError } from "@/lib/security/private-auth-http";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";

const PUBLIC_AUTH_METHODS = new Map([
  ["/api/auth/unlock", "POST"],
  ["/api/auth/session", "GET"],
  ["/api/auth/lock", "POST"],
]);
const DEFERRED_EXECUTION_PATHS = new Set([
  "/api/chat/main", "/api/orchestrate", "/api/orchestrate/stream",
]);

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return NextResponse.next();

  if (getPrivateAuthMode() === "required") {
    const publicMethod = PUBLIC_AUTH_METHODS.get(pathname);
    if (publicMethod) {
      if (request.method !== publicMethod) {
        const response = authError(405);
        response.headers.set("Allow", publicMethod);
        return response;
      }
      // These exact methods validate configuration and their own auth contract.
      return NextResponse.next({ headers: { "Cache-Control": "no-store" } });
    }

    try {
      const auth = await authorizeRoute(request, {
        route: pathname.slice(1),
        minRole: "viewer",
        privateExecutionBlocked: request.method === "POST" && DEFERRED_EXECUTION_PATHS.has(pathname),
      });
      if (!auth.ok) return auth.response;
      // No trusted identity is forwarded in headers. The handler independently
      // resolves the cookie against PostgreSQL, including after revocation here.
      return NextResponse.next({ headers: { "Cache-Control": "no-store" } });
    } catch {
      return authError(503);
    }
  }

  // Preserve the existing deployment while the entire private configuration is
  // intentionally absent. Deployment protection remains required during staging.
  if (!isFeatureEnabled("authGuard")) {
    return NextResponse.next();
  }

  if (request.method === "OPTIONS") {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization")?.trim();
  const tokenHeader = request.headers.get("x-cr8or-token")?.trim();
  if (authHeader || tokenHeader) {
    return NextResponse.next();
  }

  return NextResponse.json(
    {
      ok: false,
      message: "Authentication required.",
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required.",
      },
    },
    { status: 401 },
  );
}

export const config = {
  runtime: "nodejs",
  matcher: ["/api/:path*"],
};
