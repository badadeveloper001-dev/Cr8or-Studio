import { NextRequest } from "next/server";

import {
  authError, authJson, PrivateAuthMutationError, PrivateAuthRequestError,
  readPrivateAuthConfig, readUnlockBody, requireAuthMutation, setSessionCookie,
} from "@/lib/security/private-auth-http";
import { enforceUnlockRateLimit, PrivateAuthRateLimitError } from "@/lib/security/private-auth-rate-limit";
import { authenticateOwnerAccessCode, PrivateAuthBusyError } from "@/lib/security/private-auth-service";
import { SessionStoreError } from "@/lib/security/session-store";

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
    const { accessCode } = await readUnlockBody(request);
    await enforceUnlockRateLimit(request, config.rateLimitKey);
    const result = await authenticateOwnerAccessCode(accessCode);
    if (!result) return authError(401, "Invalid credentials.");
    const response = authJson({ ok: true, authenticated: true, expiresAt: result.session.expiresAt.toISOString() });
    setSessionCookie(response, result.token, result.session.expiresAt, config);
    return response;
  } catch (error) {
    if (error instanceof PrivateAuthRequestError || error instanceof PrivateAuthMutationError) return authError(400);
    if (error instanceof PrivateAuthRateLimitError) return authError(429, undefined, error.retryAfter);
    if (error instanceof PrivateAuthBusyError) return authError(429, undefined, 1);
    if (error instanceof SessionStoreError &&
        ["CREDENTIAL_VERSION_CHANGED", "OWNER_NOT_PROVISIONED"].includes(error.code)) {
      return authError(401, "Invalid credentials.");
    }
    // Never pass database, crypto, submitted credential, or connection details to
    // logs or responses. No infrastructure failure can produce a session.
    return authError(503);
  }
}

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
