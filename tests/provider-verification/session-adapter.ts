import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Process } from "@daytona/sdk";
import { COMMAND_CATALOGUE } from "../../src/lib/security/command-catalogue";
import { shellQuote } from "../../src/lib/workspace/cloud-path";
import { PRIVATE_CLOUD_COMMAND_PROGRAM, buildPrivateCloudCommand } from "../../src/lib/workspace/private-cloud-command-program";
import { PRIVATE_CLOUD_WRITE_PROGRAM } from "../../src/lib/workspace/private-cloud-write-program";
import { PRIVATE_GIT_PROGRAM } from "../../src/lib/workspace/private-git-program";
import { PRIVATE_REPOSITORY_PROGRAM } from "../../src/lib/workspace/private-repository-program";
import { assertOfflineFixtureRoot } from "./fixtures";
import { consumeOfflineOperation } from "./budget";

type Request = Parameters<Process["executeSessionCommand"]>[1];
type Logs = { output: string; stdout: string; stderr: string };
type Helper = "write" | "command" | "git" | "repository";
export type OfflineSessionOptions = Readonly<{
  onStaged?: () => void | Promise<void>;
  onPoll?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
  beforeStart?: () => void | Promise<void>;
  fault?: "none" | "disconnect-before-commit" | "invalid-response" | "cleanup-failure";
  commandDuration?: "normal" | "short";
}>;
export type OfflineSessionEvidence = Readonly<{
  mode: "OFFLINE"; providerOperations: number; sessionsCreated: number; sessionsDeleted: number;
  commands: number; inputFrames: number; inputBytes: number; commitFrames: number; startFrames: number;
  cleanupFailures: number; helpersStillRunning: number; openSessions: number;
  fixedCommandsOnly: true; contentInArguments: false; applicationEnvironmentForwarded: false;
}>;
type Running = {
  sessionId: string; id: string; helper: Helper; child: ChildProcessWithoutNullStreams;
  stdout: Buffer; stderr: Buffer; exitCode?: number; closed: Promise<void>;
  timer: ReturnType<typeof setTimeout>; staged: boolean;
};
const failure = () => new Error("Controlled offline session operation failed.");
const LIMITS = Object.freeze({ calls: 4096, inputBytes: 4 * 1024 * 1024, outputBytes: 512 * 1024, durationMs: 85_000 });

/** Test-only SDK-shaped process. Only exact application helper command strings
 * are admitted. No shell is involved and no source, binary path, environment or
 * arbitrary working-directory override is accepted. SDK compatibility, TTY
 * behavior, network isolation and provider cancellation remain NOT RUN. */
export function createOfflineSessionAdapter(root: string, options: OfflineSessionOptions = {}) {
  assertOfflineFixtureRoot(root);
  if (!Object.keys(options).every(key => ["onStaged", "onPoll", "beforeCommit", "beforeStart", "fault", "commandDuration"].includes(key)) ||
      ![undefined, "none", "disconnect-before-commit", "invalid-response", "cleanup-failure"].includes(options.fault) ||
      ![undefined, "normal", "short"].includes(options.commandDuration)) throw failure();
  const sessions = new Set<string>();
  const commands = new Map<string, Running>();
  const counts = { providerOperations: 0, sessionsCreated: 0, sessionsDeleted: 0, commands: 0,
    inputFrames: 0, inputBytes: 0, commitFrames: 0, startFrames: 0, cleanupFailures: 0 };
  const count = () => {
    consumeOfflineOperation();
    if (++counts.providerOperations > LIMITS.calls) throw failure();
  };

  function commandProgram(): string {
    const node = realpathSync(process.execPath);
    const npm = realpathSync(path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"));
    const owner = statSync(node).uid;
    // Fixed local-install adaptations only. These explicitly do not verify the
    // deployed image's root ownership, unprivileged UID, or per-UID process cap.
    return PRIVATE_CLOUD_COMMAND_PROGRAM
      .replace('ROOT="/workspace"', `ROOT=${JSON.stringify(root)}`)
      .replace("REQUIRE_UNPRIVILEGED=True", `REQUIRE_UNPRIVILEGED=${process.getuid?.() === 0 ? "False" : "True"}`)
      .replace('NODE_CANDIDATES=("/usr/local/bin/node","/usr/bin/node")', `NODE_CANDIDATES=(${JSON.stringify(node)},)`)
      .replace('NPM_CANDIDATES=("/usr/local/bin/npm","/usr/bin/npm")', `NPM_CANDIDATES=(${JSON.stringify(npm)},)`)
      .replace('INSTALL_ROOTS=("/usr/local/","/usr/")', `INSTALL_ROOTS=(${JSON.stringify(`${path.dirname(path.dirname(node))}/`)},)`)
      .replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${[...new Set([0, owner])].join(",")},)`)
      .replace('"PATH":"/usr/local/bin:/usr/bin:/bin"', `"PATH":${JSON.stringify(`${path.dirname(node)}:/usr/bin:/bin`)}`)
      .replace("MAX_PROCESSES=64", "MAX_PROCESSES=512")
      .replace("MAX_SECONDS=60", `MAX_SECONDS=${options.commandDuration === "short" ? 2 : 60}`);
  }

  function decode(request: Request): { helper: Helper; program: string; args: string[] } {
    if (!request || typeof request.command !== "string" || request.runAsync !== true || request.suppressInputEcho !== true ||
        Object.keys(request).some(key => !["command", "runAsync", "suppressInputEcho"].includes(key))) throw failure();
    for (const [helper, program] of [["repository", PRIVATE_REPOSITORY_PROGRAM], ["git", PRIVATE_GIT_PROGRAM]] as const) {
      if (request.command === `exec python3 -I -S -u -c ${shellQuote(program)}`) {
        // The immutable local Git installation is owned by the image's UID in
        // this fixture. This is not proof of a live sandbox's root-owned Git.
        const owners = [...new Set([0, statSync("/usr/bin/git").uid])];
        return { helper, program: program.replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${owners.join(",")},)`), args: [] };
      }
    }
    const writePrefix = `exec python3 -I -S -u -c ${shellQuote(PRIVATE_CLOUD_WRITE_PROGRAM)} `;
    if (request.command.startsWith(writePrefix)) {
      const suffix = request.command.slice(writePrefix.length);
      if (!/^'[A-Za-z0-9+/=]{1,8192}'$/.test(suffix)) throw failure();
      const encoded = suffix.slice(1, -1);
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { throw failure(); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure();
      const metadata = parsed as Record<string, unknown>;
      if (Object.keys(metadata).length !== 2 || typeof metadata.path !== "string" || typeof metadata.nonce !== "string" ||
          Buffer.byteLength(metadata.path) > 4096 || !/^[0-9a-f]{32}$/.test(metadata.nonce) ||
          Buffer.from(JSON.stringify(metadata)).toString("base64") !== encoded) throw failure();
      return { helper: "write", program: PRIVATE_CLOUD_WRITE_PROGRAM, args: [encoded] };
    }
    for (const key of Object.keys(COMMAND_CATALOGUE)) {
      if (request.command === buildPrivateCloudCommand(key)) return { helper: "command", program: commandProgram(), args: [key] };
    }
    throw failure();
  }

  function current(sessionId: string, commandId: string): Running {
    const value = commands.get(commandId);
    if (!sessions.has(sessionId) || !value || value.sessionId !== sessionId) throw failure();
    return value;
  }
  function signal(value: Running, kind: NodeJS.Signals): void {
    if (value.exitCode !== undefined || !value.child.pid) return;
    try { process.kill(-value.child.pid, kind); } catch { /* Only this fixture helper's process group. */ }
  }
  async function waitFor(value: Running, duration: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([value.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), duration); })]); }
    finally { clearTimeout(timer); }
  }
  async function stop(value: Running): Promise<void> {
    signal(value, "SIGTERM");
    if (!await waitFor(value, 1500)) { signal(value, "SIGKILL"); if (!await waitFor(value, 1500)) { counts.cleanupFailures++; throw failure(); } }
    clearTimeout(value.timer);
    commands.delete(value.id);
  }
  async function getSessionCommandLogs(sessionId: string, commandId: string): Promise<Logs>;
  async function getSessionCommandLogs(sessionId: string, commandId: string, stdout: (chunk: string) => void, stderr: (chunk: string) => void): Promise<void>;
  async function getSessionCommandLogs(sessionId: string, commandId: string, stdout?: (chunk: string) => void, stderr?: (chunk: string) => void): Promise<Logs | void> {
    count();
    const value = current(sessionId, commandId);
    await options.onPoll?.();
    const out = value.stdout.toString("utf8");
    if (!value.staged && / STAGED(?:\s|\n)/.test(out)) { value.staged = true; await options.onStaged?.(); }
    const logs = options.fault === "invalid-response" ? { stdout: "INVALID OFFLINE RESPONSE\n", stderr: "", output: "INVALID OFFLINE RESPONSE\n" } :
      { stdout: out, stderr: value.stderr.toString("utf8"), output: out + value.stderr.toString("utf8") };
    if (stdout && stderr) { stdout(logs.stdout); stderr(logs.stderr); return; }
    return logs;
  }
  const adapter = {
    async createSession(sessionId: string): Promise<void> {
      count(); assertOfflineFixtureRoot(root);
      if (!/^cr8or-[a-z-]+[0-9a-f-]{32,40}$/.test(sessionId) || sessions.has(sessionId) || sessions.size >= 2) throw failure();
      sessions.add(sessionId); counts.sessionsCreated++;
    },
    async executeSessionCommand(sessionId: string, request: Request, timeout?: number) {
      count();
      if (!sessions.has(sessionId) || [...commands.values()].some(value => value.sessionId === sessionId) || timeout !== 5) throw failure();
      const decoded = decode(request);
      const child = spawn("/usr/bin/python3", ["-I", "-S", "-u", "-c", decoded.program, ...decoded.args], {
        cwd: root, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        detached: true, shell: false, stdio: "pipe",
      });
      const id = randomUUID();
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      const value: Running = { sessionId, id, helper: decoded.helper, child, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        closed, staged: false, timer: setTimeout(() => { signal(value, "SIGTERM"); }, LIMITS.durationMs) };
      commands.set(id, value); counts.commands++;
      const collect = (channel: "stdout" | "stderr", bytes: Buffer) => {
        if (value.stdout.length + value.stderr.length + bytes.length > LIMITS.outputBytes) { signal(value, "SIGTERM"); return; }
        value[channel] = Buffer.concat([value[channel], bytes]);
      };
      child.stdout.on("data", (bytes: Buffer) => collect("stdout", bytes));
      child.stderr.on("data", (bytes: Buffer) => collect("stderr", bytes));
      child.stdin.on("error", () => { /* Writes use a sanitized callback error. */ });
      child.once("error", () => { value.exitCode = 1; clearTimeout(value.timer); resolveClosed(); });
      child.once("close", code => { value.exitCode = code ?? 1; clearTimeout(value.timer); resolveClosed(); });
      return { cmdId: id };
    },
    async sendSessionCommandInput(sessionId: string, commandId: string, data: string): Promise<void> {
      count(); const value = current(sessionId, commandId);
      if (typeof data !== "string" || Buffer.byteLength(data) > 32 * 1024 || counts.inputBytes + Buffer.byteLength(data) > LIMITS.inputBytes) throw failure();
      const commit = data === "COMMIT\n" || /^#CR8OR-WRITE\/1 [0-9a-f]{32} COMMIT\n$/.test(data);
      if (commit) {
        if (options.fault === "disconnect-before-commit") { value.child.stdin.end(); throw failure(); }
        await options.beforeCommit?.(); counts.commitFrames++;
      }
      if (data === "START\n") { await options.beforeStart?.(); counts.startFrames++; }
      counts.inputFrames++; counts.inputBytes += Buffer.byteLength(data);
      await new Promise<void>((resolve, reject) => value.child.stdin.write(data, error => error ? reject(failure()) : resolve()));
    },
    getSessionCommandLogs,
    async getSessionCommand(sessionId: string, commandId: string) {
      count(); const value = current(sessionId, commandId);
      // Never retain/return the command source or file content as evidence.
      return { id: value.id, command: `offline-fixed-${value.helper}`, exitCode: value.exitCode };
    },
    async deleteSession(sessionId: string): Promise<void> {
      count();
      if (options.fault === "cleanup-failure") { counts.cleanupFailures++; throw failure(); }
      for (const value of [...commands.values()].filter(value => value.sessionId === sessionId)) await stop(value);
      if (sessions.delete(sessionId)) counts.sessionsDeleted++;
    },
    evidence(): OfflineSessionEvidence {
      return Object.freeze({ mode: "OFFLINE", ...counts, openSessions: sessions.size,
        helpersStillRunning: [...commands.values()].filter(value => value.exitCode === undefined).length,
        fixedCommandsOnly: true, contentInArguments: false, applicationEnvironmentForwarded: false });
    },
    async dispose(): Promise<void> {
      // Only locally created helper processes; no filesystem deletion and no
      // claim that session cleanup proves descendant termination.
      for (const value of [...commands.values()]) await stop(value);
      counts.sessionsDeleted += sessions.size; sessions.clear();
    },
  };
  return adapter;
}
export type OfflineSessionAdapter = ReturnType<typeof createOfflineSessionAdapter>;
