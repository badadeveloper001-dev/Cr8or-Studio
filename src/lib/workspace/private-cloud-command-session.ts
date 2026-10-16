import "server-only";

import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@/lib/security/audit";
import { validateCommandRequest } from "@/lib/security/command-catalogue";
import { validateCommandAuthorization } from "@/lib/security/command-authorization";
import { reserveCommandOperation, markCommandDispatched, finishCommandOperation } from "@/lib/security/command-operation-store";
import { ExecutionAuthorizationError, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { buildPrivateCloudCommand } from "@/lib/workspace/private-cloud-command-program";
import type { PrivateCloudSessionProcess } from "@/lib/workspace/private-cloud-write-session";
import type { CommandResult, ValidatedCommandRequest } from "@/lib/workspace/runtime";

export const PRIVATE_CLOUD_COMMAND_SESSION_LIMITS = Object.freeze({
  durationMs: 80_000, cleanupMs: 5000, pollMs: 250, revalidateMs: 2000,
  outputBytes: 512 * 1024, returnedBytes: 64 * 1024, requestSeconds: 5,
});
const READY = "CR8OR-COMMAND/1 READY\n";
const RESULT = "CR8OR-COMMAND/1 RESULT ";
type RemoteResult = {
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "output_limit";
  exitCode: number | null; stdout: string; stderr: string; cancellationConfirmed: boolean;
};
function unavailable(): ExecutionAuthorizationError {
  return new ExecutionAuthorizationError(503, "The private command could not be completed. Its remote state may require operator verification.");
}

/** The only remote output accepted is a bounded supervisor envelope. Raw provider
 * errors/output never become logs. This is not protection against a compromised
 * sandbox supervisor; the hardcoded release gate covers that isolation gap. */
function parseTranscript(logs: { stdout?: string; stderr?: string; output?: string }): RemoteResult | undefined {
  for (const value of [logs.stdout, logs.stderr, logs.output]) {
    if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value) > PRIVATE_CLOUD_COMMAND_SESSION_LIMITS.outputBytes)) throw unavailable();
  }
  const stdout = logs.stdout ?? "";
  if (logs.stderr || (logs.output && logs.output !== stdout)) throw unavailable();
  if ((READY + RESULT).startsWith(stdout)) return;
  if (!stdout.startsWith(READY + RESULT)) throw unavailable();
  const body = stdout.slice((READY + RESULT).length);
  if (!body.endsWith("\n")) return;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw unavailable(); }
  if (!parsed || typeof parsed !== "object") throw unavailable();
  const result = parsed as RemoteResult;
  if (!Object.keys(result).every((key) => ["status", "exitCode", "stdout", "stderr", "cancellationConfirmed"].includes(key)) ||
      !["succeeded", "failed", "timed_out", "cancelled", "output_limit"].includes(result.status) ||
      !(result.exitCode === null || (Number.isInteger(result.exitCode) && result.exitCode >= -255 && result.exitCode <= 255)) ||
      typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.cancellationConfirmed !== "boolean" ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > PRIVATE_CLOUD_COMMAND_SESSION_LIMITS.returnedBytes ||
      (result.status === "succeeded" && result.exitCode !== 0) ||
      (result.status === "failed" && (result.exitCode === null || result.exitCode === 0))) throw unavailable();
  return result;
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

/** Isolated-test mechanism. Production runtime always checks the hardcoded
 * availability restriction first. Every call still requires an opaque grant
 * and live PostgreSQL authorization; direct imports are not an auth bypass. */
export async function privateCloudCommandSession(
  process: PrivateCloudSessionProcess, projectId: string, providerWorkspaceId: string,
  request: ValidatedCommandRequest, authorization: ExecutionAuthorizationContext | undefined,
): Promise<CommandResult> {
  // Copy only independently validated fields. Caller mutation cannot replace
  // the grant, operation ID or command during asynchronous provider operations.
  const entry = validateCommandRequest(request);
  request = Object.freeze({ command: entry.command, commandKey: entry.key, rules: entry.rules,
    timeoutMs: request.timeoutMs, commandAuthorization: request.commandAuthorization });
  const limits = PRIVATE_CLOUD_COMMAND_SESSION_LIMITS;
  const deadline = performance.now() + limits.durationMs;
  const sessionId = `cr8or-command-${randomUUID()}`;
  let stopped = false;
  let signal: AbortSignal | undefined;
  let grant: Awaited<ReturnType<typeof validateCommandAuthorization>> | undefined;
  let reserved = false;
  let creationStarted = false;
  let cleanupRequested = false;
  let commandId: string | undefined;
  let dispatchAttempted = false;
  let terminal: RemoteResult | undefined;
  let remoteConfirmed = false;
  let failure: ExecutionAuthorizationError | undefined;
  let lastValidation = 0;
  let transcript = "";

  const check = () => {
    if (signal?.aborted) throw new ExecutionAuthorizationError(401);
    if (stopped || performance.now() >= deadline) throw unavailable();
  };
  const bounded = async <T>(work: () => Promise<T>, listen = true): Promise<T> => {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { check(); return work(); }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { stopped = true; reject(unavailable()); }, Math.max(1, deadline - performance.now()));
          abort = () => reject(new ExecutionAuthorizationError(401));
          if (listen) { signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  };
  const validate = async () => {
    if (!authorization) throw new ExecutionAuthorizationError(401);
    grant = await bounded(() => validateCommandAuthorization(request.commandAuthorization, authorization, request), false);
    if (authorization.projectId !== projectId || authorization.workspace.runtimeType !== "cloud" ||
        authorization.workspace.provider !== "daytona" || authorization.workspace.providerWorkspaceId !== providerWorkspaceId) {
      throw new ExecutionAuthorizationError(403);
    }
    signal = authorization.signal;
    check();
    lastValidation = performance.now();
  };
  const audit = (event: string, status: string) => {
    if (!grant) return;
    appendAuditEvent({ id: randomUUID(), at: new Date().toISOString(), actorId: grant.actorId,
      actorRole: "agent", action: "sandbox.run", outcome: status === "SUCCEEDED" ? "allow" : event === "started" ? "allow" : "error",
      reason: `private command ${event}`, metadata: { operationId: grant.operationId, projectId,
        workspaceId: providerWorkspaceId, commandKey: grant.commandKey, executionId: grant.executionId, status } });
  };
  const logs = async (): Promise<RemoteResult | undefined> => {
    if (!commandId) throw unavailable();
    const current = await bounded(() => process.getSessionCommandLogs(sessionId, commandId!));
    const text = current.stdout ?? "";
    if (!text.startsWith(transcript)) throw unavailable();
    const result = parseTranscript(current);
    transcript = text;
    return result;
  };

  try {
    await validate();
    const fixedCommand = buildPrivateCloudCommand(grant!.commandKey);
    // No queued work. One shared reservation per sandbox; reused grant IDs can
    // never dispatch twice even across application instances or uncertain calls.
    await bounded(() => reserveCommandOperation({ id: grant!.operationId, projectId,
      workspaceId: providerWorkspaceId, commandKey: grant!.commandKey, actorId: grant!.actorId, executionId: grant!.executionId }));
    reserved = true;
    await validate();
    creationStarted = true;
    const creation = Promise.resolve().then(() => { check(); return process.createSession(sessionId); });
    void creation.then(() => {
      if (cleanupRequested) return settle(() => process.deleteSession(sessionId), limits.cleanupMs);
    }, () => undefined).catch(() => undefined);
    await bounded(() => creation);
    await validate();
    const command = await bounded(() => process.executeSessionCommand(sessionId,
      { command: fixedCommand, runAsync: true, suppressInputEcho: true }, limits.requestSeconds));
    parseTranscript(command);
    if (typeof command.cmdId !== "string" || !command.cmdId || command.cmdId.length > 256) throw unavailable();
    commandId = command.cmdId;
    while (transcript !== READY) {
      if (await logs()) throw unavailable();
      if (transcript !== READY) await bounded(() => new Promise<void>((resolve) => setTimeout(resolve, limits.pollMs)));
    }
    await validate();
    await bounded(() => markCommandDispatched(grant!.operationId));
    await validate();
    check();
    dispatchAttempted = true;
    // No client data, session references, credentials, cwd or environment here.
    await bounded(() => process.sendSessionCommandInput(sessionId, commandId!, "START\n"));
    audit("started", "RUNNING");
    while (true) {
      check();
      if (performance.now() - lastValidation >= limits.revalidateMs) await validate();
      terminal = await logs();
      if (terminal) {
        const status = await bounded(() => process.getSessionCommand(sessionId, commandId!));
        if (status.exitCode !== undefined && status.exitCode !== null) {
          if (status.exitCode !== 0) throw unavailable();
          remoteConfirmed = terminal.cancellationConfirmed;
          if (!remoteConfirmed) throw unavailable();
          break;
        }
      }
      await bounded(() => new Promise<void>((resolve) => setTimeout(resolve, limits.pollMs)));
    }
    await validate();
    if (terminal.status === "timed_out" || terminal.status === "cancelled") throw unavailable();
    if (terminal.status === "output_limit") throw new ExecutionAuthorizationError(409, "Command output exceeded the supported limit; no partial output is returned.");
  } catch (error) {
    failure = error instanceof ExecutionAuthorizationError ? new ExecutionAuthorizationError(error.status, error.message) : unavailable();
  } finally {
    stopped = true;
    cleanupRequested = true;
    const cleanupDeadline = performance.now() + limits.cleanupMs;
    if (commandId && !remoteConfirmed) {
      // Cancellation/cleanup may proceed after authorization loss; no output
      // from this path is ever released. DELETE alone is not process-kill proof.
      await settle(() => process.sendSessionCommandInput(sessionId, commandId!, "CANCEL\n"), 1000);
      const confirmationDeadline = Math.min(cleanupDeadline, performance.now() + 2500);
      let confirmationStopped = false;
      const confirmation = await settle(async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          if (confirmationStopped || performance.now() >= confirmationDeadline) return;
          const current = await process.getSessionCommandLogs(sessionId, commandId!);
          if (confirmationStopped || performance.now() >= confirmationDeadline) return;
          const result = parseTranscript(current);
          const state = await process.getSessionCommand(sessionId, commandId!);
          if (confirmationStopped || performance.now() >= confirmationDeadline) return;
          if (result && state.exitCode === 0 && result.cancellationConfirmed) return result;
          await new Promise<void>((resolve) => setTimeout(resolve, limits.pollMs));
        }
        return undefined;
      }, confirmationDeadline - performance.now());
      confirmationStopped = true;
      if (confirmation?.value) { terminal = confirmation.value; remoteConfirmed = true; }
    }
    const cleaned = !creationStarted || Boolean(await settle(() => process.deleteSession(sessionId), cleanupDeadline - performance.now()));
    // A remote helper may start late after an ambiguous provider response. Never
    // free that workspace on the assumption that a DELETE killed everything.
    const knownStopped = !creationStarted || remoteConfirmed;
    const status = !knownStopped || !cleaned ? "UNKNOWN" : !dispatchAttempted ? "CANCELLED" :
      terminal?.status === "timed_out" ? "TIMED_OUT" : terminal?.status === "cancelled" ? "CANCELLED" :
      terminal?.status === "succeeded" ? "SUCCEEDED" : "FAILED";
    if (reserved && grant) {
      const persisted = await settle(() => finishCommandOperation(grant!.operationId, { status,
        ...(terminal?.exitCode !== undefined && terminal.exitCode !== null ? { exitCode: terminal.exitCode } : {}),
        cancellationConfirmed: knownStopped, cleanupConfirmed: cleaned }), limits.cleanupMs);
      if (!persisted && !failure) failure = unavailable();
      audit("completed", status);
    }
    if ((!knownStopped || !cleaned) && !failure) failure = unavailable();
  }
  if (failure) throw failure;
  if (!terminal || terminal.exitCode === null) throw unavailable();
  // Includes database round trips after remote cleanup/persistence. Never release
  // output on a disconnected, revoked, expired or rotated initiating session.
  const released = await settle(async () => {
    try { await validateCommandAuthorization(request.commandAuthorization, authorization, request); return undefined; }
    catch (error) { return error instanceof ExecutionAuthorizationError ? error : unavailable(); }
  }, limits.cleanupMs);
  if (!released) throw unavailable();
  if (released.value) throw released.value;
  return { stdout: terminal.stdout, stderr: terminal.stderr, exitCode: terminal.exitCode,
    operationId: grant!.operationId, status: terminal.status, cancellationConfirmed: remoteConfirmed };
}
