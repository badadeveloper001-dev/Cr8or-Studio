import { NextRequest } from "next/server";
import { z } from "zod";
import { createCloudProject, listCloudProjects } from "@/lib/workspace/cloud-service";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try { return await listCloudProjects(request); }
  catch { return internalErrorResponse("Unable to load cloud projects. Check database configuration and migrations."); }
}
export async function POST(request: NextRequest) {
  try { return await createCloudProject(request, await request.json()); }
  catch (error) {
    if (error instanceof z.ZodError || error instanceof TypeError) return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Invalid workspace request or repository URL." });
    return internalErrorResponse("Unable to create cloud workspace. Check server configuration and repository access.");
  }
}
