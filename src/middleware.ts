import { NextRequest, NextResponse } from "next/server";

import { isFeatureEnabled } from "@/lib/config/feature-flags";

export function middleware(request: NextRequest) {
  if (!isFeatureEnabled("authGuard")) {
    return NextResponse.next();
  }

  if (request.method === "OPTIONS") {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname;
  if (!pathname.startsWith("/api/")) {
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
  matcher: ["/api/:path*"],
};
