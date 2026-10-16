import "server-only";

import { NextRequest } from "next/server";

import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { errorResponse } from "@/lib/http/api-response";
import {
  AuthSession,
  WorkspaceRole,
  hasMinRole,
  recordAccessAllowed,
  recordAccessDenied,
  resolveAuthSession,
} from "@/lib/security/auth";
import { isWorkspaceOwner } from "@/lib/security/workspace-ownership";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import {
  authError,
  PrivateAuthMutationError,
  readPrivateAuthConfig,
  requireAuthMutation,
} from "@/lib/security/private-auth-http";

export type RoutePolicy = {
  route: string;
  minRole: WorkspaceRole;
  requestId?: string;
  requireWorkspaceOwnership?: boolean;
  workspaceId?: string;
  /** Temporarily deny execution paths awaiting the Phase 1A-3B context work. */
  privateExecutionBlocked?: boolean;
};

export type AuthorizationResult =
  | { ok: true; session: AuthSession }
  | { ok: false; response: Response };

export async function authorizeRoute(
  request: NextRequest,
  policy: RoutePolicy,
): Promise<AuthorizationResult> {
  const privateAuthRequired = getPrivateAuthMode() === "required";
  let session: AuthSession | null;
  try {
    session = await resolveAuthSession(request, isFeatureEnabled("authGuard"));
  } catch {
    // The database and complete private configuration remain authoritative.
    return { ok: false, response: authError(503) };
  }

  if (!session) {
    recordAccessDenied({
      session: null,
      route: policy.route,
      method: request.method,
      reason: "missing-or-invalid-session",
      requestId: policy.requestId,
    });

    return {
      ok: false,
      response: privateAuthRequired ? authError(401) : errorResponse({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Authentication required.",
        requestId: policy.requestId,
      }),
    };
  }

  if (privateAuthRequired) {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        requireAuthMutation(request, readPrivateAuthConfig());
      }
    } catch (error) {
      return { ok: false, response: authError(error instanceof PrivateAuthMutationError ? 400 : 503) };
    }

    if (policy.privateExecutionBlocked) {
      recordAccessDenied({
        session,
        route: policy.route,
        method: request.method,
        reason: "private-execution-unavailable",
        requestId: policy.requestId,
      });
      return { ok: false, response: authError(503, "Execution is unavailable.") };
    }
  }

  if (!hasMinRole(session, policy.minRole)) {
    recordAccessDenied({
      session,
      route: policy.route,
      method: request.method,
      reason: `insufficient-role:${session.role}:requires:${policy.minRole}`,
      requestId: policy.requestId,
    });

    return {
      ok: false,
      response: noStore(errorResponse({
        status: 403,
        code: "FORBIDDEN",
        message: "Insufficient permissions for this action.",
        requestId: policy.requestId,
      })),
    };
  }

  if (policy.requireWorkspaceOwnership) {
    const workspaceId = policy.workspaceId ?? "default";
    if (!isWorkspaceOwner(session, workspaceId)) {
      recordAccessDenied({
        session,
        route: policy.route,
        method: request.method,
        reason: `not-workspace-owner:${workspaceId}`,
        requestId: policy.requestId,
      });

      return {
        ok: false,
        response: noStore(errorResponse({
          status: 403,
          code: "FORBIDDEN",
          message: "Workspace ownership required for this action.",
          requestId: policy.requestId,
        })),
      };
    }
  }

  recordAccessAllowed({
    session,
    route: policy.route,
    method: request.method,
    requestId: policy.requestId,
  });

  return { ok: true, session };
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
