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

export type RoutePolicy = {
  route: string;
  minRole: WorkspaceRole;
  requestId?: string;
  requireWorkspaceOwnership?: boolean;
  workspaceId?: string;
};

export type AuthorizationResult =
  | { ok: true; session: AuthSession }
  | { ok: false; response: Response };

export async function authorizeRoute(
  request: NextRequest,
  policy: RoutePolicy,
): Promise<AuthorizationResult> {
  const authEnabled = isFeatureEnabled("authGuard");
  const session = await resolveAuthSession(request, authEnabled);

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
      response: errorResponse({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Authentication required.",
        requestId: policy.requestId,
      }),
    };
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
      response: errorResponse({
        status: 403,
        code: "FORBIDDEN",
        message: "Insufficient permissions for this action.",
        requestId: policy.requestId,
      }),
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
        response: errorResponse({
          status: 403,
          code: "FORBIDDEN",
          message: "Workspace ownership required for this action.",
          requestId: policy.requestId,
        }),
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
