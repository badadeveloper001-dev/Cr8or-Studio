import { NextRequest } from "next/server";
import { authorizeRoute } from "@/lib/security/authorization";
import { errorResponse } from "@/lib/http/api-response";
import { cloudModeEnabled, findCloudProject } from "@/lib/workspace/cloud-projects";
import { getWorkspaceRuntime } from "@/lib/workspace/runtime-factory";
import { createExecutionAuthorization, ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";

export async function authorizedRuntime(request: NextRequest, projectId: string, write = false) {
  const auth = await authorizeRoute(request, { route: "api/workspace-files", minRole: write ? "maintainer" : "viewer" });
  if (!auth.ok) return auth;
  if (getPrivateAuthMode() === "required" || auth.session.provider === "private-session") {
    try {
      const authorization = await createExecutionAuthorization(auth.session, projectId, {
        permissions: write ? ["read", "write"] : ["read"], signal: request.signal,
      });
      return { ok: true as const, session: auth.session, authorization, runtime: await getWorkspaceRuntime(projectId, authorization) };
    } catch (error) {
      const status = error instanceof ExecutionAuthorizationError ? error.status : 503;
      const response = errorResponse({ status, code: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INTERNAL_ERROR",
        message: status === 401 ? "Authentication required." : status === 404 ? "Registered project not found." : "Authorized workspace is unavailable." });
      response.headers.set("Cache-Control", "no-store");
      return { ok: false as const, response };
    }
  }
  if (cloudModeEnabled() || projectId.startsWith("cloud-")) {
    const workspace = await findCloudProject(projectId, auth.session.userId, auth.session.role);
    if (!workspace) return { ok: false as const, response: errorResponse({ status: 404, code: "NOT_FOUND", message: "Select or clone an accessible cloud project first." }) };
  }
  return { ok: true as const, session: auth.session, authorization: undefined, runtime: await getWorkspaceRuntime(projectId) };
}
