import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizedRuntime } from "@/lib/workspace/authorized-runtime";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { errorResponse } from "@/lib/http/api-response";
import { redactText } from "@/lib/security/redaction";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import { PrivateFileWriteBodyError, readPrivateFileWriteBody } from "@/lib/security/private-file-write-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function executionFailure(error: ExecutionAuthorizationError) {
  const status = error.status;
  return errorResponse({ status,
    code: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INTERNAL_ERROR",
    message: error.message,
  });
}

async function GETHandler(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId") || "cr8or-studio";
    const access = await authorizedRuntime(request, projectId);
    if (!access.ok) return access.response;
    const path = request.nextUrl.searchParams.get("path") || ".";
    if (request.nextUrl.searchParams.get("kind") === "list") return NextResponse.json({ files: await access.runtime.listFiles(path) });
    return NextResponse.json({ path, ...(await access.runtime.readFile(path)) });
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) return executionFailure(error);
    return errorResponse({ status: 409, code: "CONFLICT", message: redactText(error instanceof Error ? error.message : "Unable to read workspace files.") });
  }
}
const writeSchema = z.object({ projectId: z.string().default("cr8or-studio"), path: z.string().min(1), content: z.string(), dryRun: z.boolean().optional(), approvalId: z.string().uuid().optional() });
async function POSTHandler(request: NextRequest) {
  const privateMode = getPrivateAuthMode() === "required";
  try {
    const payload = writeSchema.parse(await (privateMode ? readPrivateFileWriteBody(request) : request.json()));
    const access = await authorizedRuntime(request, payload.projectId, true);
    if (!access.ok) return access.response;
    const preview = { action: "files.write", path: payload.path, bytes: Buffer.byteLength(payload.content) };
    if (payload.dryRun) return NextResponse.json({ dryRun: true, preview });
    const policy = evaluatePolicyGuard({ action: "files.write", actorId: access.session.userId, actorRole: access.session.role, approvalId: payload.approvalId });
    if (!policy.allowed) return NextResponse.json({ ok: false, message: policy.reason, requiresApproval: policy.approvalRequired, preview, policy: { action: "files.write", profile: policy.profile, risk: policy.risk } }, { status: 409 });
    await access.runtime.writeFile(payload.path, payload.content);
    return NextResponse.json({ path: payload.path, saved: true });
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) return executionFailure(error);
    if (error instanceof PrivateFileWriteBodyError) return errorResponse({ status: error.status, code: "INVALID_REQUEST", message: error.message });
    if (privateMode) return errorResponse({ status: 400, code: "INVALID_REQUEST", message: "Unable to save file." });
    return errorResponse({ status: 400, code: "INVALID_REQUEST", message: redactText(error instanceof Error ? error.message : "Unable to save file.") });
  }
}

export const GET = withPrivateApiAuth(
  { route: "api/files:get", minRole: "viewer" },
  GETHandler,
);

export const POST = withPrivateApiAuth(
  { route: "api/files:post", minRole: "viewer" },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/files:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS, POST" } }),
);
