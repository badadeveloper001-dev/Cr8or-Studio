import "server-only";

import { z } from "zod";

import { errorResponse } from "@/lib/http/api-response";
import { authorizeRoute } from "@/lib/security/authorization";
import { createExecutionAuthorization, ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { authorizeOwnerGitOperation, validateGitRepositoryContext } from "@/lib/security/git-authorization";
import { isGitMutation, isGithubOperation, parseGitOperation } from "@/lib/security/git-operation-catalogue";
import { PrivateFileWriteBodyError, readPrivateFileWriteBody } from "@/lib/security/private-file-write-body";
import { assertPrivateGitAvailable } from "@/lib/workspace/private-git-availability";
import { createDaytonaGitAdapter, createGithubGitAdapter, executeAuthorizedGitOperation } from "@/lib/workspace/private-git-operations";
import type { NextRequest } from "next/server";

const privateGitEnvelope = z.object({
  projectId: z.string().min(1).max(256).refine(value => !value.includes("\0")),
  operation: z.unknown(),
  approvalId: z.string().uuid().optional(),
}).strict();

/** Both public route modules enter here before their legacy token/shell paths. */
export async function handlePrivateGitOperation(request: NextRequest, requestId: string,
  transport: "daytona" | "github"): Promise<Response> {
  try {
    const auth = await authorizeRoute(request, {
      route: transport === "daytona" ? "api/github/ops:private" : "api/github/api:private",
      minRole: "owner", requireWorkspaceOwnership: true, requestId,
    });
    if (!auth.ok) return auth.response;
    const body = privateGitEnvelope.parse(await readPrivateGitBody(request));
    let operation;
    try { operation = parseGitOperation(body.operation); } catch { throw new PrivateFileWriteBodyError(400); }
    if (isGithubOperation(operation.operation) !== (transport === "github")) throw new PrivateFileWriteBodyError(400);
    const context = await createExecutionAuthorization(auth.session, body.projectId, {
      permissions: [isGitMutation(operation.operation) ? "write" : "read"], signal: request.signal,
    });
    if (!context) throw new ExecutionAuthorizationError(401);
    await validateGitRepositoryContext(context, operation);
    // Validate canonical scope before the fixed release gate, but consume no
    // approval and reserve no mutation while dispatch remains unavailable.
    // In particular, never fall through to legacy host Git or broad-token API.
    assertPrivateGitAvailable();
    const grant = await authorizeOwnerGitOperation(context, operation, auth.session, body.approvalId);
    let adapter;
    if (transport === "github") adapter = createGithubGitAdapter(() => process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    else {
      const apiKey = process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new ExecutionAuthorizationError(503);
      const { DaytonaProvider } = await import("@/lib/workspace/providers/daytona");
      adapter = createDaytonaGitAdapter(new DaytonaProvider({ apiKey, apiUrl: process.env.DAYTONA_API_URL }));
    }
    const result = await executeAuthorizedGitOperation(grant, context, operation, adapter);
    return Response.json({ ok: result.status === "SUCCEEDED", ...result }, { status: result.status === "SUCCEEDED" ? 200 : 503 });
  } catch (error) {
    return privateGitFailure(error, requestId);
  }
}

/** Authentication and origin validation must precede this bounded body read. */
export async function readPrivateGitBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType) ||
      request.headers.has("content-encoding")) {
    throw new PrivateFileWriteBodyError(400);
  }
  // Reuse the existing 2 MiB / 10 second transport bound. Operation-specific
  // path, reference, content and metadata limits are enforced by the catalogue.
  return readPrivateFileWriteBody(request);
}

export function privateGitFailure(error: unknown, requestId: string): Response {
  if (error instanceof ExecutionAuthorizationError) {
    return errorResponse({ status: error.status, requestId, message: error.message,
      code: error.status === 401 ? "UNAUTHORIZED" : error.status === 403 ? "FORBIDDEN" :
        error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "UPSTREAM_ERROR" });
  }
  if (error instanceof z.ZodError || error instanceof PrivateFileWriteBodyError || error instanceof SyntaxError) {
    return errorResponse({ status: error instanceof PrivateFileWriteBodyError ? error.status : 400,
      code: "INVALID_REQUEST", message: "Invalid Git operation request.", requestId });
  }
  return errorResponse({ status: 503, code: "UPSTREAM_ERROR", message: "Git operation is unavailable.", requestId });
}
