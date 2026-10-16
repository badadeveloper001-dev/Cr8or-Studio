import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Process } from "@daytona/sdk";

type ExecuteRequest = Parameters<Process["executeSessionCommand"]>[1];
export type ControlledSessionLogs = { output: string; stdout: string; stderr: string };
export type ControlledSessionCommand = {
  sessionId: string;
  commandId: string;
  request: ExecuteRequest;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  exitCode?: number;
};

type AdapterOptions = {
  beforeInput?: (input: string, command: ControlledSessionCommand) => void | Promise<void>;
  onLogs?: (logs: ControlledSessionLogs, command: ControlledSessionCommand) => void | Promise<void>;
  transformLogs?: (logs: ControlledSessionLogs, command: ControlledSessionCommand) => ControlledSessionLogs;
};

/**
 * Controlled SDK-shape adapter: executes the real fixed helper against a temporary
 * local filesystem. It deliberately does not claim to emulate a live Daytona
 * session's shell, terminal, proxy, or input-delivery semantics.
 */
export function createControlledDaytonaSessionAdapter(root: string, options: AdapterOptions = {}) {
  const sessions = new Set<string>();
  const activeCommands = new Map<string, ControlledSessionCommand>();
  const exits = new Map<string, Promise<void>>();
  const calls = {
    created: [] as string[],
    commands: [] as { sessionId: string; request: ExecuteRequest; timeout?: number; commandId: string }[],
    inputs: [] as { sessionId: string; commandId: string; data: string }[],
    deleted: [] as string[],
  };

  function command(sessionId: string, commandId: string): ControlledSessionCommand {
    const current = activeCommands.get(commandId);
    if (!sessions.has(sessionId) || !current || current.sessionId !== sessionId) throw new Error("Test session unavailable.");
    return current;
  }

  function signal(current: ControlledSessionCommand, kind: NodeJS.Signals) {
    if (current.exitCode !== undefined || !current.child.pid) return;
    try { process.kill(-current.child.pid, kind); } catch { /* Already terminated. */ }
  }

  async function stop(current: ControlledSessionCommand): Promise<void> {
    signal(current, "SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exits.get(current.commandId),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 300); }),
      ]);
    } finally { clearTimeout(timer); }
    signal(current, "SIGKILL");
    await exits.get(current.commandId);
    activeCommands.delete(current.commandId);
    exits.delete(current.commandId);
  }

  async function getSessionCommandLogs(sessionId: string, commandId: string): Promise<ControlledSessionLogs>;
  async function getSessionCommandLogs(sessionId: string, commandId: string,
    onStdout: (chunk: string) => void, onStderr: (chunk: string) => void): Promise<void>;
  async function getSessionCommandLogs(sessionId: string, commandId: string,
    onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void): Promise<ControlledSessionLogs | void> {
    const current = command(sessionId, commandId);
    const logs = { output: current.stdout + current.stderr, stdout: current.stdout, stderr: current.stderr };
    await options.onLogs?.(logs, current);
    const transformed = options.transformLogs?.(logs, current) ?? logs;
    if (onStdout && onStderr) {
      // The tested transport only uses the cumulative overload. This overload
      // retains SDK assignability; it does not model a live streaming channel.
      onStdout(transformed.stdout);
      onStderr(transformed.stderr);
      return;
    }
    return transformed;
  }

  const adapter = {
    calls,
    activeCommands,
    async createSession(sessionId: string): Promise<void> {
      calls.created.push(sessionId);
      if (sessions.has(sessionId)) throw new Error("Duplicate test session.");
      sessions.add(sessionId);
    },
    async executeSessionCommand(sessionId: string, request: ExecuteRequest, timeout?: number) {
      if (!sessions.has(sessionId)) throw new Error("Test session unavailable.");
      const commandId = randomUUID();
      calls.commands.push({ sessionId, request: { ...request }, timeout, commandId });
      const child = spawn("bash", ["-c", request.command], { cwd: root, detached: true, stdio: "pipe" });
      const current: ControlledSessionCommand = { sessionId, commandId, request, child, stdout: "", stderr: "" };
      activeCommands.set(commandId, current);
      const collect = (channel: "stdout" | "stderr", chunk: Buffer) => {
        // This is a test-infrastructure guard, independent of the application guard.
        if (Buffer.byteLength(current[channel], "utf8") + chunk.length > 64 * 1024) {
          signal(current, "SIGTERM");
          return;
        }
        current[channel] += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.stdin.on("error", () => { /* Writes reject via their callback. */ });
      exits.set(commandId, new Promise<void>((resolve) => {
        child.once("error", () => { current.exitCode = 1; resolve(); });
        child.once("close", (code) => { current.exitCode = code ?? 1; resolve(); });
      }));
      return { cmdId: commandId };
    },
    async sendSessionCommandInput(sessionId: string, commandId: string, data: string): Promise<void> {
      const current = command(sessionId, commandId);
      calls.inputs.push({ sessionId, commandId, data });
      await options.beforeInput?.(data, current);
      await new Promise<void>((resolve, reject) => {
        current.child.stdin.write(data, (error) => error ? reject(new Error("Test input disconnected.")) : resolve());
      });
    },
    getSessionCommandLogs,
    async getSessionCommand(sessionId: string, commandId: string) {
      const current = command(sessionId, commandId);
      return { id: commandId, command: current.request.command, exitCode: current.exitCode };
    },
    async deleteSession(sessionId: string): Promise<void> {
      calls.deleted.push(sessionId);
      const current = [...activeCommands.values()].filter((entry) => entry.sessionId === sessionId);
      await Promise.all(current.map(stop));
      sessions.delete(sessionId);
    },
    async dispose(): Promise<void> {
      await Promise.all([...sessions].map((sessionId) => adapter.deleteSession(sessionId)));
    },
  };
  return adapter;
}

export type ControlledDaytonaSessionAdapter = ReturnType<typeof createControlledDaytonaSessionAdapter>;
