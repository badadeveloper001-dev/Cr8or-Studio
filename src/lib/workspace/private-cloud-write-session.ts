import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { Process } from "@daytona/sdk";
import { ExecutionAuthorizationError, revalidateExecutionAuthorization, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { PRIVATE_CLOUD_FILE_LIMITS } from "@/lib/workspace/private-cloud-files";
import { PRIVATE_CLOUD_WRITE_PROGRAM } from "@/lib/workspace/private-cloud-write-program";
import { privateRuntimeRelativePath } from "@/lib/workspace/private-runtime-path";

export const PRIVATE_CLOUD_WRITE_SESSION_LIMITS = Object.freeze({
  chunkBytes: 12_288,
  outputBytes: 4096,
  operationMs: 35_000,
  cleanupMs: 5000,
  pollMs: 100,
  maxPolls: 160,
  requestSeconds: 5,
});

export type PrivateCloudSessionProcess = Pick<Process,
  "createSession" | "executeSessionCommand" | "sendSessionCommandInput" |
  "getSessionCommand" | "deleteSession"> & {
    getSessionCommandLogs(sessionId: string, commandId: string): Promise<{
      stdout?: string; stderr?: string; output?: string;
    }>;
  };

function unavailable(): ExecutionAuthorizationError {
  return new ExecutionAuthorizationError(503, "The private cloud file operation could not be completed.");
}

/** Validate before provider access or Base64 allocation; preserve exact UTF-8. */
export function validatePrivateCloudWrite(relativePath: string, content: string): { relative: string; bytes: Buffer } {
  if (typeof content !== "string" || typeof relativePath !== "string") throw unavailable();
  if (content.length > PRIVATE_CLOUD_FILE_LIMITS.writeBytes ||
      Buffer.byteLength(content, "utf8") > PRIVATE_CLOUD_FILE_LIMITS.writeBytes ||
      relativePath.length > PRIVATE_CLOUD_FILE_LIMITS.pathBytes ||
      Buffer.byteLength(relativePath, "utf8") > PRIVATE_CLOUD_FILE_LIMITS.pathBytes) {
    throw new ExecutionAuthorizationError(409, "The cloud file operation exceeds the supported resource limit.");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content) throw unavailable();
  try {
    const relative = privateRuntimeRelativePath(relativePath).split("/").filter((part) => part !== "" && part !== ".").join("/");
    if (!relative) throw unavailable();
    if (Buffer.from(relative, "utf8").toString("utf8") !== relative) throw unavailable();
    return { relative, bytes };
  } catch { throw unavailable(); }
}

/** Cleanup is bounded independently of a revoked session or elapsed transfer. */
async function settleWithin(operation: () => Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Server-only two-phase transport. Only the validated capability can authorize
 * COMMIT. The runtime's separate compatibility gate remains closed until an
 * explicitly authorized isolated provider verification has passed.
 */
export async function privateCloudWriteSession(
  process: PrivateCloudSessionProcess,
  projectId: string,
  providerWorkspaceId: string,
  relativePath: string,
  content: string,
  authorization: ExecutionAuthorizationContext | undefined,
): Promise<{ bytes: number }> {
  const limits = PRIVATE_CLOUD_WRITE_SESSION_LIMITS;
  const deadline = performance.now() + limits.operationMs;
  let signal: AbortSignal | undefined;
  let stopped = false;
  let creationStarted = false;
  let cleanupRequested = false;
  let commandId: string | undefined;
  let commitSent = false;
  let result: { bytes: number } | undefined;
  let failure: ExecutionAuthorizationError | undefined;
  const sessionId = `cr8or-write-${randomBytes(16).toString("hex")}`;
  const nonce = randomBytes(16).toString("hex");
  const prefix = `#CR8OR-WRITE/1 ${nonce} `;
  const outputPrefix = `CR8OR-WRITE/1 ${nonce} `;

  const check = () => {
    if (signal?.aborted) throw new ExecutionAuthorizationError(401);
    if (stopped || performance.now() >= deadline) throw unavailable();
  };
  const bounded = async <T>(operation: () => Promise<T>, listenToAbort = true): Promise<T> => {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { check(); return operation(); }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { stopped = true; reject(unavailable()); }, Math.max(1, deadline - performance.now()));
          abort = () => reject(new ExecutionAuthorizationError(401));
          if (listenToAbort) {
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          }
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  };
  const validate = async () => {
    // Do not read properties from an unproven/fabricated capability.
    if (!authorization) throw new ExecutionAuthorizationError(401);
    // Validation aborts its capability on infrastructure/registry failures. Let
    // its precise 503/409 rejection win over the resulting abort notification.
    await bounded(() => revalidateExecutionAuthorization(authorization, projectId, "write"), false);
    if (authorization.workspace.runtimeType !== "cloud" || authorization.workspace.provider !== "daytona" ||
        !providerWorkspaceId || authorization.workspace.providerWorkspaceId !== providerWorkspaceId) {
      throw new ExecutionAuthorizationError(403);
    }
    signal = authorization.signal;
    check();
  };
  const send = async (frame: string) => {
    check();
    if (!commandId) throw unavailable();
    await bounded(() => process.sendSessionCommandInput(sessionId, commandId!, prefix + frame + "\n"));
    check();
  };
  let transcript = "";
  let polls = 0;
  const awaitTranscript = async (expected: string) => {
    while (true) {
      check();
      if (++polls > limits.maxPolls || !commandId) throw unavailable();
      const logs = await bounded(() => process.getSessionCommandLogs(sessionId, commandId!));
      check();
      for (const value of [logs.stdout, logs.stderr, logs.output]) {
        if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limits.outputBytes)) throw unavailable();
      }
      if (logs.stderr) throw unavailable();
      const stdout = logs.stdout ?? "";
      if (logs.output && logs.output !== stdout) throw unavailable();
      if (!stdout.startsWith(transcript) || !expected.startsWith(stdout)) throw unavailable();
      transcript = stdout;
      if (transcript === expected) return;
      const command = await bounded(() => process.getSessionCommand(sessionId, commandId!));
      check();
      // Exit metadata and logs can become visible independently. Successful
      // exit alone is never proof of completion; keep waiting for the frame.
      if (command.exitCode !== undefined && command.exitCode !== null && command.exitCode !== 0) throw unavailable();
      await bounded(() => new Promise<void>((resolve) => setTimeout(resolve, limits.pollMs)));
    }
  };

  try {
    await validate();
    const { relative, bytes } = validatePrivateCloudWrite(relativePath, content);
    const metadata = Buffer.from(JSON.stringify({ path: relative, nonce }), "utf8").toString("base64");
    creationStarted = true;
    const creation = Promise.resolve().then(() => { check(); return process.createSession(sessionId); });
    // A timed-out create can succeed after the first DELETE. Compensate once;
    // neither cleanup nor delayed completion may resume the transfer.
    void creation.then(() => {
      if (cleanupRequested) return settleWithin(() => process.deleteSession(sessionId), limits.cleanupMs);
    }, () => undefined).catch(() => undefined);
    await bounded(() => creation);
    await validate();
    const command = await bounded(() => process.executeSessionCommand(sessionId, {
      command: `exec python3 -I -S -u -c ${shellQuote(PRIVATE_CLOUD_WRITE_PROGRAM)} ${shellQuote(metadata)}`,
      runAsync: true,
      suppressInputEcho: true,
    }, limits.requestSeconds));
    for (const value of [command.stdout, command.stderr, command.output]) {
      if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limits.outputBytes)) throw unavailable();
    }
    if (command.stderr) throw unavailable();
    if (typeof command.cmdId !== "string" || !command.cmdId || command.cmdId.length > 256) throw unavailable();
    commandId = command.cmdId;
    // No content is sent until the helper confirms its terminal is configured.
    const ready = `${outputPrefix}READY\n`;
    await awaitTranscript(ready);
    await validate();
    await send(`BEGIN ${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}`);
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += limits.chunkBytes, sequence++) {
      await validate();
      await send(`DATA ${sequence} ${bytes.subarray(offset, offset + limits.chunkBytes).toString("base64")}`);
    }
    await send("END");
    const staged = ready + `${outputPrefix}STAGED ${bytes.length}\n`;
    await awaitTranscript(staged);
    // Last database check immediately precedes the irreversible external step.
    await validate();
    check();
    commitSent = true;
    await send("COMMIT");
    await awaitTranscript(staged + `${outputPrefix}COMMITTED ${bytes.length}\n`);
    await validate();
    result = { bytes: bytes.length };
  } catch (error) {
    // Do not retain/log provider errors: they may contain request bodies or logs.
    failure = error instanceof ExecutionAuthorizationError ? new ExecutionAuthorizationError(error.status) : unavailable();
    if (commitSent && failure.status === 503) {
      failure = new ExecutionAuthorizationError(503, "Cloud write completion could not be confirmed. Check the file before retrying.");
    }
  } finally {
    stopped = true;
    cleanupRequested = true;
    if (creationStarted) {
      const cleanupDeadline = performance.now() + limits.cleanupMs;
      if (failure && commandId && !commitSent) {
        const aborted = await settleWithin(() => process.sendSessionCommandInput(sessionId, commandId!, prefix + "ABORT\n"), 1000);
        if (aborted) {
          // Give the helper's finally block time to remove its stage before
          // session deletion can terminate it. Never let a late poll continue.
          const graceDeadline = Math.min(cleanupDeadline, performance.now() + 1000);
          await settleWithin(async () => {
            for (let attempt = 0; attempt < 10 && performance.now() < graceDeadline; attempt++) {
              const command = await process.getSessionCommand(sessionId, commandId!);
              if (command.exitCode !== undefined && command.exitCode !== null) return;
              if (performance.now() >= graceDeadline) return;
              await new Promise<void>((resolve) => setTimeout(resolve, limits.pollMs));
            }
          }, graceDeadline - performance.now());
        }
      }
      const cleaned = await settleWithin(() => process.deleteSession(sessionId), cleanupDeadline - performance.now());
      if (!cleaned && !failure) failure = new ExecutionAuthorizationError(503, "Cloud file session cleanup could not be confirmed. Check the file before retrying.");
    }
  }
  if (failure) throw failure;
  if (!result) throw unavailable();
  return result;
}
