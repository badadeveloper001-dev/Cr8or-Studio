import { NextRequest } from "next/server";
import { authorizeRoute } from "@/lib/security/authorization";
import { errorResponse } from "@/lib/http/api-response";
import { cloudModeEnabled, findCloudProject } from "@/lib/workspace/cloud-projects";
import { getWorkspaceRuntime } from "@/lib/workspace/runtime-factory";

export async function authorizedRuntime(request: NextRequest, projectId: string, write = false) {
  const auth = await authorizeRoute(request, { route: "api/workspace-files", minRole: write ? "maintainer" : "viewer" });
  if (!auth.ok) return auth;
  if (cloudModeEnabled() || projectId.startsWith("cloud-")) {
    const workspace = await findCloudProject(projectId, auth.session.userId, auth.session.role);
    if (!workspace) return { ok: false as const, response: errorResponse({ status: 404, code: "NOT_FOUND", message: "Select or clone an accessible cloud project first." }) };
  }
  return { ok: true as const, session: auth.session, runtime: await getWorkspaceRuntime(projectId) };
}
