import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { authorizeRoute } from "@/lib/security/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().default(""),
  framework: z.string().default("Next.js"),
  language: z.string().default("TypeScript"),
  repository: z.string().optional(),
});

async function GETHandler(request: NextRequest) {
  return withRouteMetrics("api/projects:get", async (_request: NextRequest, { requestId }) => {
  const auth = await authorizeRoute(request, { route: "api/projects:get", minRole: "viewer", requestId });
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, description: true, framework: true, language: true, createdAt: true },
    });
    return NextResponse.json(projects);
  } catch {
    return internalErrorResponse("Failed to list projects.", requestId);
  }
  })(request);
}

async function POSTHandler(request: NextRequest) {
  return withRouteMetrics("api/projects:post", async (request: NextRequest, { requestId }) => {
  const auth = await authorizeRoute(request, { route: "api/projects:post", minRole: "maintainer", requestId });
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const raw = await request.json();
    const data = createSchema.parse(raw);
    const project = await prisma.project.create({ data });
    return NextResponse.json(project, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse({
        status: 400,
        code: "INVALID_REQUEST",
        message: "Invalid project data.",
        details: err.issues,
        requestId,
      });
    }
    return internalErrorResponse("Failed to create project.", requestId);
  }
  })(request);
}

export const GET = withPrivateApiAuth(
  { route: "api/projects:get", minRole: "viewer" },
  GETHandler,
);

export const POST = withPrivateApiAuth(
  { route: "api/projects:post", minRole: "viewer" },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/projects:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS, POST" } }),
);
