import "server-only";

import type { NextRequest } from "next/server";

import { internalErrorResponse } from "@/lib/http/api-response";
import { authorizeRoute, type RoutePolicy } from "@/lib/security/authorization";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";

/**
 * Validate before invoking a route (including before parsing its request body).
 * Legacy handlers keep their existing behavior until the coherent private-auth
 * configuration is supplied. Each active request resolves PostgreSQL afresh.
 */
export function withPrivateApiAuth<TArgs extends unknown[]>(
  policy: RoutePolicy,
  handler: (request: NextRequest, ...args: TArgs) => Promise<Response>,
): (request: NextRequest, ...args: TArgs) => Promise<Response> {
  return async (request, ...args) => {
    if (getPrivateAuthMode() === "inactive") return handler(request, ...args);

    try {
      const authorization = await authorizeRoute(request, policy);
      const response = authorization.ok
        ? await handler(request, ...args)
        : authorization.response;
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch {
      // Unexpected handler errors must not expose sensitive details or become
      // cacheable framework responses. Do not log request/error material here.
      const response = internalErrorResponse("Request could not be completed.");
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  };
}
