import { withPrivateApiAuth } from "@/lib/security/private-api";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, internalErrorResponse } from "@/lib/http/api-response";
import { withRouteMetrics } from "@/lib/observability/sli";
import { decideApproval, listApprovals, requestApproval } from "@/lib/security/approvals";
import { authorizeRoute } from "@/lib/security/authorization";
import { findDevelopmentCommand } from "@/lib/security/command-catalogue";
import {
  createPrivateCommandApproval,
  decidePrivateCommandApproval,
  listPrivateCommandApprovals,
} from "@/lib/security/command-approvals";
import { createExecutionAuthorization, ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import { RiskAction } from "@/lib/security/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  action: z.enum(["files.write", "commands.execute", "git.commit-push", "github.write", "deploy.vercel", "project.create", "project.clone"]),
  title: z.string().min(3).max(180),
  preview: z.string().min(3).max(6000),
});

const decideSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approved", "denied"]),
  reason: z.string().max(500).optional(),
});

const bodySchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("request"), payload: requestSchema }),
  z.object({ intent: z.literal("decide"), payload: decideSchema }),
]);

const privateBodySchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("request"), payload: z.union([
    z.object({
      action: z.literal("commands.execute"),
      projectId: z.string().min(1).max(256).refine(value => !value.includes("\0")),
      commandKey: z.string().min(1).max(100),
    }).strict(),
    requestSchema.extend({ action: requestSchema.shape.action.exclude(["commands.execute"]) }).strict(),
  ]) }).strict(),
  z.object({ intent: z.literal("decide"), payload: decideSchema.extend({
    decision: z.enum(["approved", "denied", "revoked"]),
  }).strict() }).strict(),
]);

const PRIVATE_APPROVAL_BODY_BYTES = 16 * 1024;
const PRIVATE_APPROVAL_BODY_TIMEOUT_MS = 10_000;

class ApprovalBodyError extends Error {
  constructor(readonly status: 400 | 413 = 400) { super("Invalid approval request payload."); }
}

/** Bound the actual stream after authentication, including requests without Content-Length. */
async function readPrivateApprovalBody(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  const declared = request.headers.get("content-length");
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType) ||
      request.headers.has("content-encoding") ||
      (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))))) {
    throw new ApprovalBodyError();
  }
  if (declared !== null && Number(declared) > PRIVATE_APPROVAL_BODY_BYTES) throw new ApprovalBodyError(413);
  if (!request.body || request.signal.aborted) throw new ApprovalBodyError();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: (() => void) | undefined;
  let stopped = false;
  try {
    const deadline = performance.now() + PRIVATE_APPROVAL_BODY_TIMEOUT_MS;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = () => { stopped = true; reject(new ApprovalBodyError()); };
      timer = setTimeout(interrupt, PRIVATE_APPROVAL_BODY_TIMEOUT_MS);
      request.signal.addEventListener("abort", interrupt, { once: true });
      if (request.signal.aborted) interrupt();
    });
    const check = () => {
      if (stopped || request.signal.aborted || performance.now() >= deadline) throw new ApprovalBodyError();
    };
    const consume = async () => {
      const bytes = new Uint8Array(PRIVATE_APPROVAL_BODY_BYTES);
      let length = 0;
      while (true) {
        check();
        const chunk = await reader.read();
        check();
        if (chunk.done) break;
        if (chunk.value.byteLength > bytes.length - length) throw new ApprovalBodyError(413);
        bytes.set(chunk.value, length);
        length += chunk.value.byteLength;
      }
      if (declared !== null && Number(declared) !== length) throw new ApprovalBodyError();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    };
    const text = await Promise.race([consume(), interrupted]);
    check();
    return JSON.parse(text) as unknown;
  } catch (error) {
    stopped = true;
    void reader.cancel().catch(() => undefined);
    throw error instanceof ApprovalBodyError ? error : new ApprovalBodyError();
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (interrupt) request.signal.removeEventListener("abort", interrupt);
    try { reader.releaseLock(); } catch { /* A cancelled pending read may still hold the stream. */ }
  }
}

function approvalFailure(error: unknown, requestId: string): Response {
  if (error instanceof ExecutionAuthorizationError) {
    return errorResponse({ status: error.status, requestId, message: error.message,
      code: error.status === 401 ? "UNAUTHORIZED" : error.status === 403 ? "FORBIDDEN" :
        error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "UPSTREAM_ERROR" });
  }
  if (error instanceof z.ZodError || error instanceof ApprovalBodyError || error instanceof SyntaxError) {
    return errorResponse({ status: error instanceof ApprovalBodyError ? error.status : 400,
      code: "INVALID_REQUEST", message: "Invalid approval request payload.", requestId });
  }
  return errorResponse({ status: 503, code: "UPSTREAM_ERROR", message: "Approval workflow is unavailable.", requestId });
}

async function privatePOST(request: NextRequest, requestId: string): Promise<Response> {
  try {
    const auth = await authorizeRoute(request, {
      route: "api/security/approvals:post", minRole: "owner", requestId, requireWorkspaceOwnership: true,
    });
    if (!auth.ok) return auth.response;
    const body = privateBodySchema.parse(await readPrivateApprovalBody(request));
    if (body.intent === "request") {
      if (body.payload.action === "commands.execute") {
        if (!findDevelopmentCommand(body.payload.commandKey)) throw new ApprovalBodyError();
        const context = await createExecutionAuthorization(auth.session, body.payload.projectId,
          { permissions: ["command"], signal: request.signal });
        if (!context) throw new ExecutionAuthorizationError(401);
        const approval = await createPrivateCommandApproval(context, body.payload.commandKey);
        return NextResponse.json({ ok: true, approval }, { status: 201 });
      }
      const approval = requestApproval({ ...body.payload, requestedBy: auth.session.userId, requestedRole: auth.session.role });
      return NextResponse.json({ ok: true, approval }, { status: 201 });
    }

    const approval = await decidePrivateCommandApproval(auth.session, body.payload.id, body.payload.decision);
    if (approval) return NextResponse.json({ ok: true, approval }, { status: 200 });
    // Only an explicit missing durable record permits legacy fallback. Generic
    // action-only command approvals are never upgraded or decided here.
    const legacy = listApprovals(1000).find(record => record.id === body.payload.id && record.action !== "commands.execute");
    if (!legacy) throw new ExecutionAuthorizationError(404, "Approval request not found.");
    if (body.payload.decision === "revoked") throw new ApprovalBodyError();
    const record = decideApproval({ ...body.payload, decision: body.payload.decision,
      decidedBy: auth.session.userId, decidedRole: auth.session.role });
    return NextResponse.json({ ok: true, approval: record }, { status: 200 });
  } catch (error) {
    return approvalFailure(error, requestId);
  }
}

async function GETHandler(request: NextRequest) {
  return withRouteMetrics("api/security/approvals:get", async (request: NextRequest, { requestId }) => {
    const auth = await authorizeRoute(request, {
      route: "api/security/approvals:get",
      minRole: "viewer",
      requestId,
    });
    if (!auth.ok) return auth.response;

    const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 500)) : 100;
    let records;
    try {
      records = getPrivateAuthMode() === "inactive" ? listApprovals(limit) : [
        ...await listPrivateCommandApprovals(auth.session, limit),
        ...listApprovals(1000).filter(record => record.action !== "commands.execute"),
      ].sort((left, right) => Date.parse(right.requestedAt) - Date.parse(left.requestedAt)).slice(0, limit);
    } catch (error) {
      return approvalFailure(error, requestId);
    }

    return NextResponse.json(
      {
        ok: true,
        approvals: records,
      },
      { status: 200 },
    );
  })(request);
}

async function POSTHandler(request: NextRequest) {
  return withRouteMetrics("api/security/approvals:post", async (request: NextRequest, { requestId }) => {
    if (getPrivateAuthMode() !== "inactive") return privatePOST(request, requestId);
    try {
      const raw = await request.json();
      const body = bodySchema.parse(raw);

      if (body.intent === "request") {
        const auth = await authorizeRoute(request, {
          route: "api/security/approvals:request",
          minRole: "maintainer",
          requestId,
          requireWorkspaceOwnership: true,
        });
        if (!auth.ok) return auth.response;

        const record = requestApproval({
          action: body.payload.action as RiskAction,
          title: body.payload.title,
          preview: body.payload.preview,
          requestedBy: auth.session.userId,
          requestedRole: auth.session.role,
        });

        return NextResponse.json({ ok: true, approval: record }, { status: 201 });
      }

      const auth = await authorizeRoute(request, {
        route: "api/security/approvals:decide",
        minRole: "owner",
        requestId,
        requireWorkspaceOwnership: true,
      });
      if (!auth.ok) return auth.response;

      const record = decideApproval({
        id: body.payload.id,
        decision: body.payload.decision,
        reason: body.payload.reason,
        decidedBy: auth.session.userId,
        decidedRole: auth.session.role,
      });

      if (!record) {
        return errorResponse({
          status: 404,
          code: "NOT_FOUND",
          message: "Approval request not found.",
          requestId,
        });
      }

      return NextResponse.json({ ok: true, approval: record }, { status: 200 });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return errorResponse({
          status: 400,
          code: "INVALID_REQUEST",
          message: "Invalid approval request payload.",
          details: error.issues,
          requestId,
        });
      }
      return internalErrorResponse("Approval workflow operation failed.", requestId);
    }
  })(request);
}

export const GET = withPrivateApiAuth(
  { route: "api/security/approvals:get", minRole: "viewer" },
  GETHandler,
);

export const POST = withPrivateApiAuth(
  { route: "api/security/approvals:post", minRole: "viewer" },
  POSTHandler,
);

export const OPTIONS = withPrivateApiAuth(
  { route: "api/security/approvals:options", minRole: "viewer" },
  async () => new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS, POST" } }),
);
