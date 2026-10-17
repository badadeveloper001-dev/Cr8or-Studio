import "server-only";

import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http/api-response";
import { authorizeRoute } from "@/lib/security/authorization";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import { authError } from "@/lib/security/private-auth-http";
import { parseWorkspaceLifecycleRequest, type WorkspaceLifecycleRequest } from "@/lib/security/workspace-lifecycle-catalogue";
import {
  decideWorkspaceLifecycle,
  executeWorkspaceLifecycle,
  inspectWorkspaceLifecycle,
  prepareWorkspaceLifecycle,
  readWorkspaceLifecycle,
  reconcileWorkspaceLifecycle,
} from "@/lib/workspace/private-workspace-lifecycle";
import { assertWorkspaceLifecycleAvailable } from "@/lib/workspace/private-workspace-lifecycle-availability";

export const PRIVATE_LIFECYCLE_BODY_LIMITS = Object.freeze({ bytes: 32 * 1024, timeoutMs: 10_000 });
const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const envelope = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), request: z.unknown() }).strict(),
  z.object({ action: z.literal("execute"), request: z.unknown(), approvalId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal("decide"), approvalId: z.string().uuid(), decision: z.enum(["approve", "reject"]) }).strict(),
  z.object({ action: z.literal("status"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("reconcile"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("open"), projectId: identifier }).strict(),
  z.object({ action: z.literal("state"), projectId: identifier }).strict(),
]);

export class PrivateLifecycleBodyError extends Error {
  constructor(readonly status: 400 | 413 = 400) {
    super("Invalid workspace lifecycle request.");
    this.name = "PrivateLifecycleBodyError";
  }
}

/** Call only after authentication and origin validation. No unbounded json() read. */
export async function readPrivateLifecycleBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  const declared = request.headers.get("content-length");
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType) ||
      request.headers.has("content-encoding") ||
      (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))))) {
    throw new PrivateLifecycleBodyError();
  }
  if (declared !== null && Number(declared) > PRIVATE_LIFECYCLE_BODY_LIMITS.bytes) throw new PrivateLifecycleBodyError(413);
  if (!request.body || request.signal.aborted) throw new PrivateLifecycleBodyError();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: (() => void) | undefined;
  let stopped = false;
  try {
    const deadline = performance.now() + PRIVATE_LIFECYCLE_BODY_LIMITS.timeoutMs;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = () => { stopped = true; reject(new PrivateLifecycleBodyError()); };
      timer = setTimeout(interrupt, PRIVATE_LIFECYCLE_BODY_LIMITS.timeoutMs);
      request.signal.addEventListener("abort", interrupt, { once: true });
      if (request.signal.aborted) interrupt();
    });
    const check = () => {
      if (stopped || request.signal.aborted || performance.now() >= deadline) throw new PrivateLifecycleBodyError();
    };
    const consume = async () => {
      const buffer = new Uint8Array(PRIVATE_LIFECYCLE_BODY_LIMITS.bytes);
      let length = 0;
      while (true) {
        check();
        const chunk = await reader.read();
        check();
        if (chunk.done) break;
        if (chunk.value.byteLength > buffer.length - length) throw new PrivateLifecycleBodyError(413);
        buffer.set(chunk.value, length);
        length += chunk.value.byteLength;
      }
      if (declared !== null && Number(declared) !== length) throw new PrivateLifecycleBodyError();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    };
    const text = await Promise.race([consume(), interrupted]);
    check();
    return JSON.parse(text) as unknown;
  } catch (error) {
    stopped = true;
    void reader.cancel().catch(() => undefined);
    throw error instanceof PrivateLifecycleBodyError ? error : new PrivateLifecycleBodyError();
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (interrupt) request.signal.removeEventListener("abort", interrupt);
    try { reader.releaseLock(); } catch { /* A cancelled pending read may still hold the stream. */ }
  }
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function privateLifecycleFailure(error: unknown): Response {
  if (error instanceof PrivateLifecycleBodyError || error instanceof z.ZodError || error instanceof SyntaxError) {
    return noStore(errorResponse({ status: error instanceof PrivateLifecycleBodyError ? error.status : 400,
      code: "INVALID_REQUEST", message: "Invalid workspace lifecycle request." }));
  }
  if (error instanceof ExecutionAuthorizationError) {
    const status = error.status;
    return noStore(errorResponse({ status, code: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" :
      status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "UPSTREAM_ERROR",
    // Do not relay database/provider messages through an HTTP response.
    message: status === 401 ? "Authentication required." : status === 403 ? "Workspace lifecycle request is forbidden." :
      status === 404 ? "Workspace lifecycle record not found." : status === 409 ? "Workspace lifecycle request conflicts with current state." :
      "Workspace lifecycle is unavailable." }));
  }
  return noStore(errorResponse({ status: 503, code: "UPSTREAM_ERROR", message: "Workspace lifecycle is unavailable." }));
}

/** Existing create/clone routes cannot enter the legacy broad-token provider path. */
export async function rejectPrivateLegacyWorkspaceCreation(request: NextRequest): Promise<Response> {
  try {
    const auth = await authorizeRoute(request, { route: "api/workspaces:create:private", minRole: "owner" });
    if (!auth.ok) return noStore(auth.response);
    assertWorkspaceLifecycleAvailable();
    // Even after a reviewed provider release, legacy requests have no durable
    // idempotency key or structured approval. Use the explicit lifecycle API.
    return authError(503, "Use the private workspace lifecycle workflow.");
  } catch (error) {
    return privateLifecycleFailure(error);
  }
}

export async function handlePrivateWorkspaceLifecycle(request: NextRequest): Promise<Response> {
  try {
    if (getPrivateAuthMode() === "inactive") return authError(503, "Workspace lifecycle is unavailable.");
    const auth = await authorizeRoute(request, { route: "api/workspaces/lifecycle:post", minRole: "owner" });
    if (!auth.ok) return noStore(auth.response);
    const body = envelope.parse(await readPrivateLifecycleBody(request));
    if (body.action === "prepare" || body.action === "execute") {
      let operation: WorkspaceLifecycleRequest;
      try { operation = parseWorkspaceLifecycleRequest(body.request); }
      catch { throw new PrivateLifecycleBodyError(); }
      if (body.action === "prepare") {
        const approval = await prepareWorkspaceLifecycle(auth.session, operation, request.signal);
        return noStore(Response.json({ ok: true, approval }, { status: 201 }));
      }
      assertWorkspaceLifecycleAvailable();
      const operationState = await executeWorkspaceLifecycle(auth.session, operation, body.approvalId, request.signal);
      return noStore(Response.json({ ok: operationState.ok, operation: operationState }, { status: operationState.ok ? 200 : 503 }));
    }
    if (body.action === "decide") {
      const approval = await decideWorkspaceLifecycle(auth.session, body.approvalId, body.decision);
      return noStore(Response.json({ ok: true, approval }));
    }
    if (body.action === "status") {
      const operationState = await readWorkspaceLifecycle(auth.session, body.operationId);
      return noStore(Response.json({ ok: true, operation: operationState }));
    }
    // Provider-backed reads also remain behind the fixed release gate. They do
    // not imply authorization to create/start/stop/recover a resource.
    assertWorkspaceLifecycleAvailable();
    if (body.action === "reconcile") {
      const operationState = await reconcileWorkspaceLifecycle(auth.session, body.operationId, request.signal);
      return noStore(Response.json({ ok: true, operation: operationState }));
    }
    const workspace = await inspectWorkspaceLifecycle(auth.session, body.projectId, request.signal);
    return noStore(Response.json({ ok: true, workspace }));
  } catch (error) {
    return privateLifecycleFailure(error);
  }
}
