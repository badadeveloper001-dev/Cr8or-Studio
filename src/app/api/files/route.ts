import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizedRuntime } from "@/lib/workspace/authorized-runtime";
import { evaluatePolicyGuard } from "@/lib/security/policy";
import { errorResponse } from "@/lib/http/api-response";
import { redactText } from "@/lib/security/redaction";

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId") || "cr8or-studio";
    const access = await authorizedRuntime(request, projectId);
    if (!access.ok) return access.response;
    const path = request.nextUrl.searchParams.get("path") || ".";
    if (request.nextUrl.searchParams.get("kind") === "list") return NextResponse.json({ files: await access.runtime.listFiles(path) });
    return NextResponse.json({ path, ...(await access.runtime.readFile(path)) });
  } catch (error) {
    return errorResponse({ status: 409, code: "CONFLICT", message: redactText(error instanceof Error ? error.message : "Unable to read workspace files.") });
  }
}
const writeSchema = z.object({ projectId: z.string().default("cr8or-studio"), path: z.string().min(1), content: z.string(), dryRun: z.boolean().optional(), approvalId: z.string().uuid().optional() });
export async function POST(request: NextRequest) {
  try {
    const payload = writeSchema.parse(await request.json());
    const access = await authorizedRuntime(request, payload.projectId, true);
    if (!access.ok) return access.response;
    const preview = { action: "files.write", path: payload.path, bytes: Buffer.byteLength(payload.content) };
    if (payload.dryRun) return NextResponse.json({ dryRun: true, preview });
    const policy = evaluatePolicyGuard({ action: "files.write", actorId: access.session.userId, actorRole: access.session.role, approvalId: payload.approvalId });
    if (!policy.allowed) return NextResponse.json({ ok: false, message: policy.reason, requiresApproval: policy.approvalRequired, preview, policy: { action: "files.write", profile: policy.profile, risk: policy.risk } }, { status: 409 });
    await access.runtime.writeFile(payload.path, payload.content);
    return NextResponse.json({ path: payload.path, saved: true });
  } catch (error) {
    return errorResponse({ status: 400, code: "INVALID_REQUEST", message: redactText(error instanceof Error ? error.message : "Unable to save file.") });
  }
}
