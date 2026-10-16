import { NextRequest } from "next/server";

import { authError, authJson, readPrivateAuthConfig, readSessionToken } from "@/lib/security/private-auth-http";
import { resolveOwnerSession } from "@/lib/security/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function methodNotAllowed() {
  const response = authError(405);
  response.headers.set("Allow", "GET");
  return response;
}

export async function GET(request: NextRequest) {
  if (request.method !== "GET") return methodNotAllowed();
  try {
    const config = readPrivateAuthConfig();
    const token = readSessionToken(request, config);
    const session = token ? await resolveOwnerSession(token) : null;
    return authJson(session
      ? { ok: true, authenticated: true, expiresAt: session.expiresAt.toISOString() }
      : { ok: true, authenticated: false });
  } catch {
    return authError(503);
  }
}

export const POST = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
