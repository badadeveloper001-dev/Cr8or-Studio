import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrivateCloudCommand } from "@/lib/workspace/private-cloud-command-program";
import { privateRepositorySession } from "@/lib/workspace/private-repository-session";
import { validateRepositoryInitialization } from "@/lib/security/git-repository-initialization";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { createOfflineSandbox, createPilotFixture, PILOT_REPOSITORY_KEY, readFixtureProcessEvidence, type PilotFixture } from "../provider-verification/fixtures";
import { createOfflineSessionAdapter, type OfflineSessionAdapter } from "../provider-verification/session-adapter";

const roots: string[] = [];
const adapters: OfflineSessionAdapter[] = [];
async function fixture(): Promise<PilotFixture> { const value = await createPilotFixture(); roots.push(value.root); return value; }
async function sandbox() { const root = await createOfflineSandbox(); roots.push(root); return root; }
function adapter(root: string, options: Parameters<typeof createOfflineSessionAdapter>[1] = {}) {
  const value = createOfflineSessionAdapter(root, options); adapters.push(value); return value;
}
const metadata = (value: PilotFixture) => ({ operationId: "offline-helper-integrity", projectId: "offline-project",
  workspaceRecordId: "offline-registration", providerWorkspaceId: "offline-sandbox",
  repositoryKey: value.repositoryKey, branch: value.branch, head: value.head });
afterEach(async () => {
  for (const value of adapters.splice(0)) await value.dispose();
  // Unit tests explicitly remove only roots allocated in this test. The runner
  // and adapter themselves retain filesystem evidence for operator review.
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("offline provider fixtures and exact fixed-helper adapter", () => {
  it("creates deterministic complete linear history with binary, empty and Unicode data", async () => {
    const left = await fixture(), right = await fixture();
    expect(left.head).toBe(right.head);
    expect(left.firstHead).toBe(right.firstHead);
    expect(left.graph).toEqual(right.graph);
    expect(left.root).not.toBe(right.root);
    expect(left.repositoryKey).toBe(PILOT_REPOSITORY_KEY);
    const graph = validateRepositoryInitialization(left.graph, { repositoryKey: left.repositoryKey, branch: left.branch, head: left.head });
    expect(graph.commits).toHaveLength(2);
    expect(graph.commits[0].parent).toBeNull();
    expect(graph.commits[1].parent).toBe(left.firstHead);
    expect(graph.commits.every(commit => !commit.message.startsWith("VFY-"))).toBe(true);
    for (const file of left.files) {
      const bytes = await fs.readFile(path.join(left.repositoryRoot, file.path));
      expect(bytes.length).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(left.files.some(file => file.bytes === 0)).toBe(true);
    expect(left.files.some(file => file.path === "binary.bin")).toBe(true);
    expect(left.files.some(file => file.path.includes("你好"))).toBe(true);
  });
  it("admits only newly allocated offline roots", () => {
    expect(() => createOfflineSessionAdapter("/workspace")).toThrow("Unknown offline fixture root.");
    expect(() => createOfflineSessionAdapter("/tmp")).toThrow("Unknown offline fixture root.");
  });
  it.each(["echo anything", "/bin/sh -c true", "npm test", `${buildPrivateCloudCommand("npm test")} ; echo injected`])("rejects a nonfixed command before dispatch", async command => {
    const process = adapter(await sandbox());
    const session = `cr8or-command-${randomUUID()}`;
    await process.createSession(session);
    await expect(process.executeSessionCommand(session, { command, runAsync: true, suppressInputEcho: true }, 5)).rejects.toThrow("Controlled offline session");
    expect(process.evidence()).toMatchObject({ commands: 0, inputBytes: 0 });
  });
  it("rejects unexpected request fields and disabled input echo suppression", async () => {
    const process = adapter(await sandbox());
    const session = `cr8or-command-${randomUUID()}`;
    await process.createSession(session);
    const command = buildPrivateCloudCommand("npm test");
    await expect(process.executeSessionCommand(session, { command, runAsync: true, suppressInputEcho: false }, 5)).rejects.toThrow();
    await expect(process.executeSessionCommand(session, { command, runAsync: true, suppressInputEcho: true, cwd: "/workspace" } as never, 5)).rejects.toThrow();
    expect(process.evidence().commands).toBe(0);
  });
  it("uses the actual initializer and preserves all synthetic file bytes without command content", async () => {
    const source = await fixture();
    const destination = await sandbox();
    const process = adapter(destination);
    let validations = 0;
    // Pure helper/transport fixture, deliberately not a claim of owner auth.
    // The standalone workflow separately uses real PostgreSQL authorization.
    const result = await privateRepositorySession(process, metadata(source), source.graph, async () => { validations++; }, new AbortController().signal);
    expect(result).toMatchObject({ status: "SUCCEEDED", state: "READY", head: source.head, branch: source.branch });
    expect(validations).toBeGreaterThanOrEqual(3);
    for (const file of source.files) expect(await fs.readFile(path.join(destination, "repo", file.path))).toEqual(await fs.readFile(path.join(source.repositoryRoot, file.path)));
    expect(process.evidence()).toMatchObject({ mode: "OFFLINE", commands: 1, commitFrames: 1, openSessions: 0,
      helpersStillRunning: 0, fixedCommandsOnly: true, contentInArguments: false, applicationEnvironmentForwarded: false });
    expect(JSON.stringify(process.evidence())).not.toContain(source.graph.objects[0].contentBase64);
  }, 15000);
  it("rejects publication when revalidation fails after staging", async () => {
    const source = await fixture(), destination = await sandbox();
    let invalid = false;
    const process = adapter(destination, { onStaged: () => { invalid = true; } });
    await expect(privateRepositorySession(process, metadata(source), source.graph, async () => {
      if (invalid) throw new ExecutionAuthorizationError(401);
    }, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    expect(process.evidence().commitFrames).toBe(0);
    expect(await fs.readdir(destination)).toEqual([]);
  }, 15000);
  it.each(["invalid-response", "disconnect-before-commit"] as const)("never turns a controlled %s into confirmed success", async fault => {
    const source = await fixture(), destination = await sandbox();
    const process = adapter(destination, { fault });
    const result = await privateRepositorySession(process, metadata(source), source.graph, async () => undefined, new AbortController().signal);
    expect(result.status).not.toBe("SUCCEEDED");
    expect(process.evidence().commitFrames).toBe(0);
    expect(await fs.readdir(destination)).toEqual([]);
  }, 15000);
  it("executes only a fixed allowed benign npm script with a clean environment", async () => {
    const source = await fixture(), process = adapter(source.root);
    const session = `cr8or-command-${randomUUID()}`;
    await process.createSession(session);
    const command = await process.executeSessionCommand(session, { command: buildPrivateCloudCommand("npm test"), runAsync: true, suppressInputEcho: true }, 5);
    let output = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      output = (await process.getSessionCommandLogs(session, command.cmdId)).stdout;
      if (output.includes(" READY\n")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(output).toContain(" READY\n");
    await process.sendSessionCommandInput(session, command.cmdId, "START\n");
    for (let attempt = 0; attempt < 200; attempt++) {
      output = (await process.getSessionCommandLogs(session, command.cmdId)).stdout;
      if (output.includes(" RESULT ")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(output).toContain('"status":"succeeded"');
    expect(output).toContain('"cancellationConfirmed":true');
    expect(output).toContain("synthetic verification complete");
    expect(process.evidence().startFrames).toBe(1);
  }, 15000);
  it("independently observes same-group fixture descendants stop after cancellation", async () => {
    const source = await fixture(), process = adapter(source.root);
    const session = `cr8or-command-${randomUUID()}`;
    await process.createSession(session);
    const command = await process.executeSessionCommand(session, { command: buildPrivateCloudCommand("npm run test:integration"), runAsync: true, suppressInputEcho: true }, 5);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = (await process.getSessionCommandLogs(session, command.cmdId)).stdout.includes(" READY\n");
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(ready).toBe(true);
    await process.sendSessionCommandInput(session, command.cmdId, "START\n");
    let processes = await readFixtureProcessEvidence(source.root);
    for (let attempt = 0; attempt < 100 && processes.length < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      processes = await readFixtureProcessEvidence(source.root);
    }
    expect(processes).toHaveLength(3);
    expect(processes.every(value => value.running)).toBe(true);
    await process.sendSessionCommandInput(session, command.cmdId, "CANCEL\n");
    for (let attempt = 0; attempt < 150; attempt++) {
      processes = await readFixtureProcessEvidence(source.root);
      if (processes.every(value => !value.running)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(processes.every(value => !value.running)).toBe(true);
    // No DELETE was required to obtain independent termination observations.
    expect(process.evidence().sessionsDeleted).toBe(0);
  }, 15000);
});
