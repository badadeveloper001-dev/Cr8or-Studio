import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest } from "next/server";
import { z } from "zod";
import { createCloudProject, listCloudProjects } from "@/lib/workspace/cloud-service";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function GETHandler(request: NextRequest) {
  try { return await listCloudProjects(request); }
  catch { return internalErrorResponse("Unable to load cloud projects. Check database configuration and migrations."); }
}
async function POSTHandler(request: NextRequest) {
  try { return await createCloudProject(request, await request.json()); }
  catch (error) {
    if (error instanceof z.ZodError || error instanceof TypeError) return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid workspace request or repository URL." });
    return internalErrorResponse("Unable to create cloud workspace. Check server configuration and repository access.");
  }
}

export const GET = withPrivateApiAuth(
  { route: "api/workspaces:get", minRole: "viewer" },
  GETHandler,
);

export const POST = withPrivateApiAuth(
  { route: "api/workspaces:post", minRole: "viewer" },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/workspaces:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS, POST" } }),
);
