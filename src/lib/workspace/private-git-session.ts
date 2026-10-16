import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import {
  buildGitOperationScope, canonicalGitRepository, gitScopeDigest, parseGitOperation,
  validateGitOperationScope, validGitPath, type GitOperationRequest, type GitOperationScope,
} from "@/lib/security/git-operation-catalogue";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { PRIVATE_GIT_LIMITS, PRIVATE_GIT_PROGRAM } from "@/lib/workspace/private-git-program";
import type { PrivateCloudSessionProcess } from "@/lib/workspace/private-cloud-write-session";

export const PRIVATE_GIT_SESSION_LIMITS = Object.freeze({
  durationMs: 40_000, callMs: 5_000, cleanupMs: 5_000, pollMs: 250, revalidateMs: 2_000,
  outputBytes: PRIVATE_GIT_LIMITS.outputBytes + 128, requestBytes: PRIVATE_GIT_LIMITS.requestBytes,
});
const READY = "CR8OR-GIT/1 READY\n";
const RESULT = "CR8OR-GIT/1 RESULT ";
const LOCAL = new Set(["status", "branch", "changes", "diff", "log", "remote", "stage", "unstage", "commit"]);
const failureSchema = z.object({ ok: z.literal(false), error: z.enum(["REJECTED", "CONFLICT", "BUSY", "CANCELLED", "LIMIT", "UNCERTAIN"]) }).strict();
const successSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
type Terminal = z.infer<typeof failureSchema> | z.infer<typeof successSchema>;
export type PrivateGitSessionResult = {
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  data?: unknown;
  cancellationConfirmed: boolean;
  cleanupConfirmed: boolean;
};

function unavailable(): ExecutionAuthorizationError {
  return new ExecutionAuthorizationError(503, "The private Git operation could not be verified.");
}
function transcript(logs: { stdout?: string; stderr?: string; output?: string }): { ready: boolean; result?: Terminal } {
  for (const value of [logs.stdout, logs.stderr, logs.output]) {
    if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value, "utf8") > PRIVATE_GIT_SESSION_LIMITS.outputBytes)) throw unavailable();
  }
  const output = logs.stdout ?? "";
  if (logs.stderr || (logs.output && logs.output !== output)) throw unavailable();
  const ready = output.startsWith(READY);
  const body = ready ? output.slice(READY.length) : output;
  if (!body || RESULT.startsWith(body) || (!ready && READY.startsWith(body))) return { ready };
  if (!body.startsWith(RESULT)) throw unavailable();
  const wire = body.slice(RESULT.length);
  if (!wire.endsWith("\n")) return { ready };
  let parsed: unknown;
  try { parsed = JSON.parse(wire); } catch { throw unavailable(); }
  const result = z.union([successSchema, failureSchema]).safeParse(parsed);
  if (!result.success || (!ready && result.data.ok)) throw unavailable();
  return { ready, result: result.data };
}

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const state = { head: oid.nullable(), branch: z.string().nullable(), index: z.string().regex(/^[a-f0-9]{64}$/) };
function resultData(data: unknown, scope: GitOperationScope): unknown {
  const change = z.object({ status: z.string().regex(/^[ MADRCU?!]{2}$/), path: z.string().refine(validGitPath) }).strict();
  const title = z.string().regex(/^PROJECT-[0-9]{3,9}: (?:General maintenance|Code improvements|Documentation updates|Test improvements|Configuration updates)$/);
  const historicalTitle = z.string().regex(/^[A-Z][A-Z0-9]{1,11}-[0-9]{3,9}: (?:General maintenance|Code improvements|Documentation updates|Test improvements|Configuration updates)$/);
  const schemas: Record<string, z.ZodType> = {
    status: z.object({ ...state, changes: z.array(change).max(1000) }).strict(),
    changes: z.object({ ...state, changes: z.array(change).max(1000) }).strict(),
    branch: z.object(state).strict(),
    diff: z.object({ unstaged: z.string(), staged: z.string() }).strict(),
    remote: z.object({ name: z.literal("origin"), url: z.literal(canonicalGitRepository(`https://github.com/${scope.repositoryKey}`).url) }).strict(),
    log: z.object({ commits: z.array(z.object({ sha: oid, timestamp: z.number().int().nonnegative(),
      title: z.union([historicalTitle, z.literal("Commit")]) }).strict()).max(20) }).strict(),
    stage: z.object({ ...state, operation: z.literal("stage") }).strict(),
    unstage: z.object({ ...state, operation: z.literal("unstage") }).strict(),
    commit: z.object({ ...state, operation: z.literal("commit"), title }).strict(),
  };
  const parsed = schemas[scope.operationKey]?.safeParse(data);
  if (!parsed?.success || (parsed.data && typeof parsed.data === "object" && "branch" in parsed.data && parsed.data.branch !== scope.branch)) throw unavailable();
  return parsed.data;
}

async function settle<T>(work: () => Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work).then((value) => ({ value }), () => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Fixed-purpose isolated-test transport. The provider adapter and coordinator
 * must first validate the opaque grant, exact sandbox and hardcoded release
 * restriction. This callback is server-created and never comes from request JSON.
 * Deleting a session is cleanup, not evidence that its Git processes stopped. */
export async function privateGitSession(
  process: PrivateCloudSessionProcess, proposedRequest: GitOperationRequest, proposedScope: GitOperationScope,
  revalidate: () => Promise<void>, signal: AbortSignal,
): Promise<PrivateGitSessionResult> {
  const request = parseGitOperation(proposedRequest);
  const scope = validateGitOperationScope(proposedScope);
  const derived = buildGitOperationScope({ projectId: scope.projectId, workspace: {
    id: scope.workspaceRecordId, runtimeType: "cloud", provider: "daytona", providerWorkspaceId: scope.providerWorkspaceId,
    repositoryUrl: canonicalGitRepository(`https://github.com/${scope.repositoryKey}`).url, branch: scope.branch,
  } }, request);
  if (!LOCAL.has(request.operation) || gitScopeDigest(derived) !== gitScopeDigest(scope) || typeof revalidate !== "function") {
    throw new ExecutionAuthorizationError(403, "Git operation is outside the approved scope.");
  }
  const metadata: Record<string, unknown> = { operation: request.operation, branch: scope.branch,
    expectedRepository: canonicalGitRepository(`https://github.com/${scope.repositoryKey}`).url };
  if ("paths" in request) metadata.paths = request.paths;
  if (request.operation === "stage" || request.operation === "unstage" || request.operation === "commit") {
    metadata.expectedHead = request.expectedHead;
    metadata.expectedIndex = request.expectedIndex;
  }
  if (request.operation === "commit") { metadata.commitPrefix = "PROJECT"; metadata.category = request.category; }
  const frame = JSON.stringify(metadata) + "\n";
  const limits = PRIVATE_GIT_SESSION_LIMITS;
  if (Buffer.byteLength(frame, "utf8") > limits.requestBytes) throw new ExecutionAuthorizationError(403, "Git request exceeds the supported limit.");
  const deadline = performance.now() + limits.durationMs;
  const sessionId = `cr8or-git-${randomUUID()}`;
  let creationAttempted = false, executionAttempted = false, cleanupRequested = false, stopped = false;
  let commandId: string | undefined, previous = "";
  let terminal: Terminal | undefined;
  let remoteConfirmed = false, cleanupConfirmed = false, startSent = false;
  let failed = false;
  let authorizationFailure: ExecutionAuthorizationError | undefined;
  let lastValidation = 0;
  const check = () => {
    if (signal.aborted) throw new ExecutionAuthorizationError(401);
    if (stopped || performance.now() >= deadline) throw unavailable();
  };
  const bounded = async <T>(work: () => Promise<T>, listen = true): Promise<T> => {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { check(); return work(); }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { stopped = true; reject(unavailable()); }, Math.max(1, Math.min(limits.callMs, deadline - performance.now())));
          if (listen) {
            abort = () => reject(new ExecutionAuthorizationError(401));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }
        }),
      ]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
  };
  const validate = async () => {
    await bounded(revalidate, false);
    check();
    lastValidation = performance.now();
  };
  const read = async () => {
    const logs = await bounded(() => process.getSessionCommandLogs(sessionId, commandId!));
    const current = logs.stdout ?? "";
    if (!current.startsWith(previous)) throw unavailable();
    previous = current;
    return transcript(logs);
  };
  const wait = () => bounded(() => new Promise<void>((resolve) => setTimeout(resolve, limits.pollMs)));
  try {
    await validate();
    creationAttempted = true;
    const creation = Promise.resolve().then(() => { check(); return process.createSession(sessionId); });
    void creation.then(() => {
      if (cleanupRequested) return settle(() => process.deleteSession(sessionId), limits.cleanupMs);
    }, () => undefined).catch(() => undefined);
    await bounded(() => creation);
    await validate();
    executionAttempted = true;
    const command = await bounded(() => process.executeSessionCommand(sessionId, {
      command: `exec python3 -I -S -u -c ${shellQuote(PRIVATE_GIT_PROGRAM)}`, runAsync: true, suppressInputEcho: true,
    }, limits.callMs / 1000));
    transcript(command);
    if (typeof command.cmdId !== "string" || !/^[^\x00-\x20\x7f]{1,256}$/.test(command.cmdId)) throw unavailable();
    commandId = command.cmdId;
    await validate();
    await bounded(() => process.sendSessionCommandInput(sessionId, commandId!, frame));
    while (true) {
      if (performance.now() - lastValidation >= limits.revalidateMs) await validate();
      const output = await read();
      if (output.result) { terminal = output.result; break; }
      if (output.ready) {
        await validate();
        startSent = true;
        await bounded(() => process.sendSessionCommandInput(sessionId, commandId!, "START\n"));
        break;
      }
      await wait();
    }
    while (true) {
      if (performance.now() - lastValidation >= limits.revalidateMs) await validate();
      const output = await read();
      terminal = output.result;
      if (terminal) {
        const state = await bounded(() => process.getSessionCommand(sessionId, commandId!));
        if (state.exitCode !== undefined && state.exitCode !== null) {
          if (state.exitCode !== (terminal.ok ? 0 : 1) || (!startSent && terminal.ok)) throw unavailable();
          remoteConfirmed = terminal.ok || terminal.error !== "UNCERTAIN";
          break;
        }
      }
      await wait();
    }
    await validate();
  } catch (error) {
    failed = true;
    if (error instanceof ExecutionAuthorizationError && error.status !== 503) authorizationFailure = new ExecutionAuthorizationError(error.status);
    // Raw provider messages and transcript fragments never escape or become logs.
  } finally {
    stopped = true;
    cleanupRequested = true;
    const cleanupDeadline = performance.now() + limits.cleanupMs;
    if (commandId && !remoteConfirmed) {
      await settle(() => process.sendSessionCommandInput(sessionId, commandId!, "CANCEL\n"), 1000);
      const confirmationDeadline = Math.min(cleanupDeadline, performance.now() + 2000);
      while (performance.now() < confirmationDeadline) {
        const confirmation = await settle(async () => {
          const output = transcript(await process.getSessionCommandLogs(sessionId, commandId!));
          const state = await process.getSessionCommand(sessionId, commandId!);
          return output.result && (!output.result.ok || startSent) && state.exitCode === (output.result.ok ? 0 : 1) ? output.result : undefined;
        }, confirmationDeadline - performance.now());
        if (confirmation?.value) {
          terminal = confirmation.value;
          remoteConfirmed = terminal.ok || terminal.error !== "UNCERTAIN";
          break;
        }
        if (!confirmation) break;
        await settle(() => new Promise<void>((resolve) => setTimeout(resolve, limits.pollMs)), confirmationDeadline - performance.now());
      }
    }
    cleanupConfirmed = !creationAttempted || !!await settle(() => process.deleteSession(sessionId), cleanupDeadline - performance.now());
  }
  const cancellationConfirmed = !executionAttempted || remoteConfirmed;
  if (authorizationFailure) throw authorizationFailure;
  const base = { cancellationConfirmed, cleanupConfirmed };
  if (failed || !cancellationConfirmed || !cleanupConfirmed || !terminal) return { status: "UNKNOWN", ...base };
  if (!terminal.ok) return { status: "FAILED", ...base };
  // Database revalidation happens after cleanup as well: revoked owners never
  // receive the operation's private output, even if external work completed.
  const release = await settle(async () => { await revalidate(); if (signal.aborted) throw new ExecutionAuthorizationError(401); return true; }, limits.callMs);
  if (!release) return { status: "UNKNOWN", ...base };
  try { return { status: "SUCCEEDED", data: resultData(terminal.data, scope), ...base }; }
  catch { return { status: "UNKNOWN", ...base }; }
}
