import { NextRequest, NextResponse } from "next/server";

import {
  authError, clearSessionCookie, PrivateAuthMutationError, readPrivateAuthConfig,
  readSessionToken, requireAuthMutation,
} from "@/lib/security/private-auth-http";
import { resolveOwnerSession, revokeSession } from "@/lib/security/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function methodNotAllowed() {
  const response = authError(405);
  response.headers.set("Allow", "POST");
  return response;
}

export async function POST(request: NextRequest) {
  if (request.method !== "POST") return methodNotAllowed();
  try {
    const config = readPrivateAuthConfig();
    requireAuthMutation(request, config);
    const token = readSessionToken(request, config);
    const session = token ? await resolveOwnerSession(token) : null;
    if (session) await revokeSession(session.id);
    // Clear only after successful revocation (or an already-invalid session).
    // Database failure returns 503 without falsely claiming a completed lock.
    const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    clearSessionCookie(response, config);
    return response;
  } catch (error) {
    return authError(error instanceof PrivateAuthMutationError ? 400 : 503);
  }
}

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
