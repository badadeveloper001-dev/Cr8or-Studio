import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { validateRepositoryInitialization } from "@/lib/security/git-repository-initialization";
import { canonicalGitRepository, validGitRef } from "@/lib/security/git-operation-catalogue";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { PRIVATE_REPOSITORY_LIMITS as limits, PRIVATE_REPOSITORY_PROGRAM } from "@/lib/workspace/private-repository-program";
import type { PrivateCloudSessionProcess } from "@/lib/workspace/private-cloud-write-session";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const metadataSchema = z.object({ operationId: identifier, projectId: identifier, workspaceRecordId: identifier,
  providerWorkspaceId: identifier, repositoryKey: z.string().max(140), branch: z.string().refine(validGitRef),
  head: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export type RepositoryInitializationMetadata = Readonly<z.infer<typeof metadataSchema>>;
export type PrivateRepositorySessionResult = Readonly<{
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN"; state?: "READY" | "ABSENT" | "INCOMPLETE" | "UNEXPECTED";
  head?: string | null; branch?: string | null; cancellationConfirmed: boolean; cleanupConfirmed: boolean;
}>;
const prefix = "CR8OR-REPOSITORY/1 ";
const terminalSchema = z.union([
  z.object({ ok: z.literal(false), error: z.enum(["REJECTED", "UNCERTAIN"]) }).strict(),
  z.object({ ok: z.literal(true), data: z.object({ state: z.enum(["READY", "ABSENT", "INCOMPLETE", "UNEXPECTED"]),
    head: z.string().regex(/^[a-f0-9]{40}$/).nullable(), branch: z.string().nullable() }).strict() }).strict(),
]);
type Terminal = z.infer<typeof terminalSchema>;
function unavailable() { return new ExecutionAuthorizationError(503, "The repository initialization could not be verified."); }
function parseLogs(logs: { stdout?: string; stderr?: string; output?: string }) {
  for (const value of [logs.stdout, logs.stderr, logs.output]) {
    if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value) > limits.outputBytes)) throw unavailable();
  }
  if (logs.stderr || (logs.output && logs.output !== logs.stdout)) throw unavailable();
  let value = logs.stdout ?? "";
  const ready = value.startsWith(`${prefix}READY\n`);
  if (ready) value = value.slice(`${prefix}READY\n`.length);
  const staged = value.startsWith(`${prefix}STAGED\n`);
  if (staged) value = value.slice(`${prefix}STAGED\n`.length);
  if (!value || `${prefix}RESULT `.startsWith(value) || (!ready && `${prefix}READY\n`.startsWith(value)) ||
      (ready && !staged && `${prefix}STAGED\n`.startsWith(value))) return { ready, staged };
  if (!value.startsWith(`${prefix}RESULT `)) throw unavailable();
  if (!value.endsWith("\n")) return { ready, staged };
  let result: Terminal;
  try { result = terminalSchema.parse(JSON.parse(value.slice(`${prefix}RESULT `.length))); } catch { throw unavailable(); }
  if (result.ok && !ready) throw unavailable();
  return { ready, staged, result };
}
async function settle<T>(work: () => Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(work).then(value => ({ value }), () => undefined),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Internal server transport, never an authorization capability. Its caller must
 * enforce the opaque lifecycle grant, exact provider mapping and release gate.
 * Session inputs contain objects but never credentials; the control plane remains
 * trusted. Deleting a session is cleanup, not process-cancellation proof. */
export async function privateRepositorySession(
  process: PrivateCloudSessionProcess, proposedMetadata: RepositoryInitializationMetadata, graph: unknown,
  revalidate: () => Promise<void>, signal: AbortSignal, mode: "initialize" | "inspect" = "initialize",
): Promise<PrivateRepositorySessionResult> {
  let metadata: RepositoryInitializationMetadata;
  let payload: Buffer;
  try {
    metadata = metadataSchema.parse(proposedMetadata);
    if (canonicalGitRepository(`https://github.com/${metadata.repositoryKey}`).key !== metadata.repositoryKey ||
        !["initialize", "inspect"].includes(mode) || typeof revalidate !== "function") throw unavailable();
    validateRepositoryInitialization(graph, { repositoryKey: metadata.repositoryKey, branch: metadata.branch, head: metadata.head });
    payload = Buffer.from(JSON.stringify(graph), "utf8");
    if (payload.length > limits.encodedBytes) throw unavailable();
  } catch { throw unavailable(); }
  const frame = JSON.stringify({ ...metadata, mode, payloadBytes: payload.length }) + "\n";
  const sessionId = `cr8or-repository-${randomUUID()}`;
  const deadline = performance.now() + limits.durationMs;
  let creationAttempted = false, executionAttempted = false, cleanupRequested = false, stopped = false;
  let commandId: string | undefined, previous = "", lastValidation = 0, sdkCalls = 0;
  let terminal: Terminal | undefined, remoteConfirmed = false, cleanupConfirmed = false, commitSent = false, failed = false;
  let authorizationFailure: ExecutionAuthorizationError | undefined;
  function check() {
    if (signal.aborted) throw new ExecutionAuthorizationError(401);
    if (stopped || performance.now() >= deadline) throw unavailable();
  }
  async function bounded<T>(work: () => Promise<T>, listen = true): Promise<T> {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => { check(); return work(); }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { stopped = true; reject(unavailable()); }, Math.max(1, Math.min(limits.requestMs, deadline - performance.now())));
        if (listen) { abort = () => reject(new ExecutionAuthorizationError(401)); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }
      })]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
  }
  async function sdk<T>(work: () => Promise<T>): Promise<T> {
    if (++sdkCalls > limits.sdkCalls) throw unavailable();
    return bounded(work);
  }
  async function validate() { await bounded(revalidate, false); check(); lastValidation = performance.now(); }
  async function read() {
    const logs = await sdk(() => process.getSessionCommandLogs(sessionId, commandId!));
    const current = logs.stdout ?? "";
    if (!current.startsWith(previous)) throw unavailable();
    previous = current;
    return parseLogs(logs);
  }
  const pause = () => bounded(() => new Promise<void>(resolve => setTimeout(resolve, limits.pollMs)));
  try {
    await validate(); creationAttempted = true;
    const creation = Promise.resolve().then(() => { check(); return process.createSession(sessionId); });
    void creation.then(() => { if (cleanupRequested) return settle(() => process.deleteSession(sessionId), limits.cleanupMs); }, () => undefined).catch(() => undefined);
    if (++sdkCalls > limits.sdkCalls) throw unavailable();
    await bounded(() => creation); await validate(); executionAttempted = true;
    const command = await sdk(() => process.executeSessionCommand(sessionId, {
      command: `exec python3 -I -S -u -c ${shellQuote(PRIVATE_REPOSITORY_PROGRAM)}`, runAsync: true, suppressInputEcho: true,
    }, limits.requestMs / 1000));
    parseLogs(command);
    if (typeof command.cmdId !== "string" || !/^[^\x00-\x20\x7f]{1,256}$/.test(command.cmdId)) throw unavailable();
    commandId = command.cmdId;
    await validate(); await sdk(() => process.sendSessionCommandInput(sessionId, commandId!, frame));
    while (true) {
      const output = await read();
      if (output.result) { terminal = output.result; break; }
      if (output.ready) {
        for (let offset = 0; offset < payload.length; offset += limits.chunkBytes) {
          if (performance.now() - lastValidation >= limits.revalidateMs) await validate();
          // JSON is ASCII-safe because wire blobs are Base64, but filenames can be
          // Unicode in metadata. Split using UTF-8-safe characters below instead.
          const end = Math.min(offset + limits.chunkBytes, payload.length);
          let boundary = end;
          while (boundary < payload.length && (payload[boundary] & 0xc0) === 0x80) boundary--;
          const chunk = payload.subarray(offset, boundary).toString("utf8");
          await sdk(() => process.sendSessionCommandInput(sessionId, commandId!, chunk));
          offset = boundary - limits.chunkBytes;
        }
        break;
      }
      if (performance.now() - lastValidation >= limits.revalidateMs) await validate();
      await pause();
    }
    while (true) {
      if (performance.now() - lastValidation >= limits.revalidateMs) await validate();
      const output = await read();
      if (output.staged && !commitSent) {
        if (mode !== "initialize") throw unavailable();
        await validate(); commitSent = true;
        await sdk(() => process.sendSessionCommandInput(sessionId, commandId!, "COMMIT\n"));
      }
      if (output.result) {
        terminal = output.result;
        const state = await sdk(() => process.getSessionCommand(sessionId, commandId!));
        if (state.exitCode !== undefined && state.exitCode !== null) {
          if (state.exitCode !== (terminal.ok ? 0 : 1) || (terminal.ok && mode === "initialize" && !commitSent)) throw unavailable();
          remoteConfirmed = terminal.ok || terminal.error !== "UNCERTAIN";
          break;
        }
      }
      await pause();
    }
    await validate();
  } catch (error) {
    failed = true;
    if (error instanceof ExecutionAuthorizationError && error.status !== 503) authorizationFailure = new ExecutionAuthorizationError(error.status);
  } finally {
    stopped = true; cleanupRequested = true;
    const cleanupDeadline = performance.now() + limits.cleanupMs;
    if (commandId && !remoteConfirmed) {
      await settle(() => process.sendSessionCommandInput(sessionId, commandId!, "CANCEL\n"), 1000);
      const until = Math.min(cleanupDeadline, performance.now() + 2000);
      let cleanupPolls = 0;
      while (performance.now() < until && cleanupPolls++ < limits.cleanupPolls) {
        const confirmation = await settle(async () => {
          const output = parseLogs(await process.getSessionCommandLogs(sessionId, commandId!));
          const state = await process.getSessionCommand(sessionId, commandId!);
          return output.result && state.exitCode === (output.result.ok ? 0 : 1) ? output.result : undefined;
        }, until - performance.now());
        if (confirmation?.value) { terminal = confirmation.value; remoteConfirmed = terminal.ok || terminal.error !== "UNCERTAIN"; break; }
        if (!confirmation) break;
        await settle(() => new Promise<void>(resolve => setTimeout(resolve, limits.pollMs)), until - performance.now());
      }
    }
    cleanupConfirmed = !creationAttempted || !!await settle(() => process.deleteSession(sessionId), cleanupDeadline - performance.now());
  }
  const common = { cleanupConfirmed, cancellationConfirmed: !executionAttempted || remoteConfirmed };
  if (authorizationFailure) throw authorizationFailure;
  if (failed || !common.cancellationConfirmed || !cleanupConfirmed || !terminal) return { status: "UNKNOWN", ...common };
  if (!terminal.ok) return { status: "FAILED", ...common };
  if (terminal.data.state === "READY" ? terminal.data.head !== metadata.head || terminal.data.branch !== metadata.branch :
      terminal.data.head !== null || terminal.data.branch !== null || mode !== "inspect") return { status: "UNKNOWN", ...common };
  if (!await settle(async () => { await revalidate(); if (signal.aborted) throw unavailable(); return true; }, limits.requestMs)) return { status: "UNKNOWN", ...common };
  return { status: "SUCCEEDED", ...terminal.data, ...common };
}
