import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPrivateCloudCommand,
  PRIVATE_CLOUD_COMMAND_LIMITS,
  PRIVATE_CLOUD_COMMAND_PROGRAM,
} from "@/lib/workspace/private-cloud-command-program";

const prefix = "CR8OR-COMMAND/1 ";
const children: ChildProcessWithoutNullStreams[] = [];
let root: string;

type Result = {
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "output_limit";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancellationConfirmed: boolean;
};

async function fixtureProgram(overrides: { seconds?: number; root?: string; handshakeSeconds?: number } = {}) {
  const node = await fs.realpath(process.execPath);
  const npm = await fs.realpath(path.join(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"));
  const installation = path.dirname(path.dirname(node));
  const trustedOwners = new Set([0, (await fs.stat(node)).uid]);
  // Only this disposable harness adapts a fixed production install/root to the
  // local readonly Node installation. There are no production env overrides.
  return PRIVATE_CLOUD_COMMAND_PROGRAM
    .replace('ROOT="/workspace"', `ROOT=${JSON.stringify(overrides.root ?? root)}`)
    .replace('NODE_CANDIDATES=("/usr/local/bin/node","/usr/bin/node")', `NODE_CANDIDATES=(${JSON.stringify(node)},)`)
    .replace('NPM_CANDIDATES=("/usr/local/bin/npm","/usr/bin/npm")', `NPM_CANDIDATES=(${JSON.stringify(npm)},)`)
    .replace('INSTALL_ROOTS=("/usr/local/","/usr/")', `INSTALL_ROOTS=(${JSON.stringify(`${installation}/`)},)`)
    .replace('TRUSTED_OWNER_UIDS=(0,)', `TRUSTED_OWNER_UIDS=(${[...trustedOwners].join(",")},)`)
    .replace('REQUIRE_UNPRIVILEGED=True', `REQUIRE_UNPRIVILEGED=${process.getuid?.() === 0 ? "False" : "True"}`)
    .replace('"PATH":"/usr/local/bin:/usr/bin:/bin"', `"PATH":${JSON.stringify(`${path.dirname(node)}:/usr/bin:/bin`)}`)
    // The shared test UID also owns Vitest and parallel build processes. The
    // production per-UID ceiling is 64; fixtures use a separate higher ceiling.
    .replace("MAX_PROCESSES=64", "MAX_PROCESSES=512")
    .replace("MAX_SECONDS=60", `MAX_SECONDS=${overrides.seconds ?? 5}`)
    .replace("HANDSHAKE_SECONDS=10", `HANDSHAKE_SECONDS=${overrides.handshakeSeconds ?? 3}`);
}

async function fixture(source: string) {
  await fs.writeFile(path.join(root, "repo", "fixture.cjs"), source);
  await fs.writeFile(path.join(root, "repo", "package.json"), JSON.stringify({
    name: "isolated-command-fixture", version: "1.0.0", private: true,
    scripts: Object.fromEntries(["typecheck", "lint", "test", "test:unit", "test:integration"].map((name) => [name, "node fixture.cjs"])),
  }));
}

async function start(command = "npm run typecheck", overrides: Parameters<typeof fixtureProgram>[0] = {}) {
  const program = await fixtureProgram(overrides);
  const child = spawn("python3", ["-I", "-S", "-u", "-c", program, command], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: "synthetic-database-secret", GITHUB_TOKEN: "synthetic-github-secret", OPENAI_API_KEY: "synthetic-ai-secret", OWNER_SESSION_TOKEN: "synthetic-session-secret" },
  });
  children.push(child);
  child.stdin.on("error", () => {});
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const completed = new Promise<{ code: number | null; stdout: string; stderr: string; result: Result }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        const resultLine = stdout.split("\n").find((line) => line.startsWith(`${prefix}RESULT `));
        if (!resultLine) throw new Error("The supervisor did not report a terminal result.");
        const result = JSON.parse(resultLine.slice(`${prefix}RESULT `.length)) as Result;
        resolve({ code, stdout, stderr, result });
      } catch (error) { reject(error); }
    });
  });
  async function ready() {
    if (stdout.includes(`${prefix}READY\n`)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("Supervisor readiness timed out.")); }, 5_000);
      const inspect = () => { if (stdout.includes(`${prefix}READY\n`)) { cleanup(); resolve(); } };
      const closed = () => { cleanup(); reject(new Error("Supervisor closed before readiness.")); };
      function cleanup() { clearTimeout(timer); child.stdout.off("data", inspect); child.off("close", closed); }
      child.stdout.on("data", inspect);
      child.once("close", closed);
      inspect();
    });
  }
  return { child, ready, completed };
}

async function run(command = "npm run typecheck", overrides: Parameters<typeof fixtureProgram>[0] = {}) {
  const operation = await start(command, overrides);
  await operation.ready();
  operation.child.stdin.write("START\n");
  return operation.completed;
}

async function fileCreated(filename: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.stat(path.join(root, "repo", filename)).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Disposable command did not create its start marker.");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-command-program-"));
  await fs.mkdir(path.join(root, "repo"));
  await fixture('console.log("exact output 🌍");');
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_500);
      await closed;
      clearTimeout(timer);
    }
  }));
  await fs.rm(root, { recursive: true, force: true });
});

describe("fixed command supervisor with real isolated npm processes", () => {
  it.each(["npm run typecheck", "npm run lint", "npm test", "npm run test:unit", "npm run test:integration"])("executes only the exact catalogue command %s", async (command) => {
    const response = await run(command);
    expect(response.result).toMatchObject({ status: "succeeded", exitCode: 0, cancellationConfirmed: true, stderr: "" });
    expect(response.result.stdout).toContain("exact output 🌍\n");
    expect(response.stderr).toBe("");
    expect(response.stdout.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("runs in the descriptor-bound repository with a fresh environment and removes the private HOME", async () => {
    await fixture('console.log("ENV="+JSON.stringify({cwd:process.cwd(),home:process.env.HOME,variables:process.env}));');
    const response = await run();
    expect(response.result.status).toBe("succeeded");
    const data = JSON.parse(response.result.stdout.split("\n").find((line) => line.startsWith("ENV="))!.slice(4));
    expect(data.cwd).toBe(path.join(root, "repo"));
    expect(data.home).toMatch(/^\/tmp\/cr8or-command-/);
    expect(data.variables).not.toHaveProperty("DATABASE_URL");
    expect(data.variables).not.toHaveProperty("GITHUB_TOKEN");
    expect(data.variables).not.toHaveProperty("OPENAI_API_KEY");
    expect(data.variables).not.toHaveProperty("OWNER_SESSION_TOKEN");
    expect(JSON.stringify(response)).not.toContain("synthetic-");
    await expect(fs.stat(data.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a nonzero exit without successful completion", async () => {
    await fixture('process.stderr.write("fixture failure\\n");process.exit(7);');
    const response = await run();
    expect(response.result).toMatchObject({ status: "failed", exitCode: 7, cancellationConfirmed: true });
    expect(response.result.stderr).toContain("fixture failure\n");
  });

  it.each(["npm run lint; touch injected", "npm test $(touch injected)", "npm test -- --watch", "NPM_TOKEN=secret npm test", "npm run test:unknown"])("rejects non-catalogue input %s before dispatch", async (command) => {
    const operation = await start(command);
    const response = await operation.completed;
    expect(response.result).toMatchObject({ status: "failed", exitCode: null, stdout: "", stderr: "" });
    expect(response.stdout).not.toContain("READY");
    expect(() => buildPrivateCloudCommand(command)).toThrow("not permitted");
    await expect(fs.stat(path.join(root, "repo", "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not dispatch before START, and cancels safely before dispatch", async () => {
    await fixture('require("fs").writeFileSync("started","yes");');
    const operation = await start();
    await operation.ready();
    await expect(fs.stat(path.join(root, "repo", "started"))).rejects.toMatchObject({ code: "ENOENT" });
    operation.child.stdin.write("CANCEL\n");
    expect((await operation.completed).result).toMatchObject({ status: "cancelled", exitCode: null, cancellationConfirmed: true });
    await expect(fs.stat(path.join(root, "repo", "started"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["START; touch injected\n", "START\nSTART\n", "A".repeat(100), "arbitrary\n"])("rejects malformed protocol input without executing (%j)", async (input) => {
    await fixture('require("fs").writeFileSync("started","yes");');
    const operation = await start();
    await operation.ready();
    operation.child.stdin.write(input);
    expect((await operation.completed).result).toMatchObject({ status: "failed", exitCode: null, stdout: "", stderr: "" });
    await expect(fs.stat(path.join(root, "repo", "started"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds the pre-dispatch handshake duration", async () => {
    const operation = await start("npm test", { handshakeSeconds: 1 });
    await operation.ready();
    expect((await operation.completed).result).toMatchObject({ status: "timed_out", exitCode: null, cancellationConfirmed: true });
  });

  it("cancels on disconnect before START", async () => {
    const operation = await start();
    await operation.ready();
    operation.child.stdin.end();
    expect((await operation.completed).result).toMatchObject({ status: "cancelled", exitCode: null, cancellationConfirmed: true });
  });

  it.each(["cancel", "disconnect", "terminate"])("attempts process-group cancellation on %s and suppresses partial output", async (reason) => {
    await fixture('require("fs").writeFileSync("started",String(process.pid));console.log("partial output");setInterval(()=>{},1000);');
    const operation = await start();
    await operation.ready();
    operation.child.stdin.write("START\n");
    await fileCreated("started");
    if (reason === "cancel") operation.child.stdin.write("CANCEL\n");
    else if (reason === "disconnect") operation.child.stdin.end();
    else operation.child.kill("SIGTERM");
    const response = await operation.completed;
    expect(response.result.status).toBe("cancelled");
    expect(response.result.stdout).toBe("");
    expect(response.result.stderr).toBe("");
    // Linux may retain orphan zombies under the container's PID 1. Only report
    // confirmed=true if the helper actually observes group disappearance.
    if (response.result.cancellationConfirmed) {
      const pid = Number(await fs.readFile(path.join(root, "repo", "started"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  it("enforces the remote duration and never reports a timeout as success", async () => {
    await fixture('console.log("incomplete");setInterval(()=>{},1000);');
    const response = await run("npm test", { seconds: 1 });
    expect(response.result).toMatchObject({ status: "timed_out", stdout: "", stderr: "" });
  });

  it("bounds combined stdout/stderr and discards incomplete output", async () => {
    await fixture('process.stdout.write("s".repeat(40000));process.stderr.write("e".repeat(40000));setInterval(()=>{},1000);');
    const response = await run();
    expect(response.result).toMatchObject({ status: "output_limit", stdout: "", stderr: "" });
    expect(Buffer.byteLength(response.stdout)).toBeLessThan(PRIVATE_CLOUD_COMMAND_LIMITS.responseBytes);
  });

  it("keeps JSON expansion bounded for control-character output", async () => {
    await fixture('process.stdout.write(Buffer.alloc(62000,1));');
    const response = await run();
    expect(response.result.status).toBe("succeeded");
    expect(response.result.stdout).toContain("\u0001".repeat(100));
    expect(Buffer.byteLength(response.stdout)).toBeLessThan(PRIVATE_CLOUD_COMMAND_LIMITS.responseBytes);
  });

  it("rejects invalid UTF-8 replacement expansion beyond the returned-output limit", async () => {
    await fixture('process.stdout.write(Buffer.alloc(62000,255));');
    const response = await run();
    expect(response.result).toMatchObject({ status: "output_limit", stdout: "", stderr: "" });
  });

  it("enforces the inherited per-file write limit", async () => {
    await fixture('require("fs").writeFileSync("oversized.bin",Buffer.alloc(17*1024*1024));');
    const response = await run();
    expect(response.result.status).toBe("failed");
    expect(response.result.exitCode).not.toBe(0);
    expect((await fs.stat(path.join(root, "repo", "oversized.bin"))).size).toBeLessThanOrEqual(PRIVATE_CLOUD_COMMAND_LIMITS.fileBytes);
  });

  it("rejects a symlinked repository before readiness", async () => {
    await fs.rename(path.join(root, "repo"), path.join(root, "outside"));
    await fs.symlink(path.join(root, "outside"), path.join(root, "repo"));
    const response = await (await start()).completed;
    expect(response.result).toMatchObject({ status: "failed", exitCode: null });
    expect(response.stdout).not.toContain("READY");
  });

  it("rejects a repository replaced between READY and START", async () => {
    const operation = await start();
    await operation.ready();
    await fs.rename(path.join(root, "repo"), path.join(root, "old"));
    await fs.mkdir(path.join(root, "repo"));
    operation.child.stdin.write("START\n");
    expect((await operation.completed).result).toMatchObject({ status: "failed", exitCode: null });
  });

  it("does not include application environment values or project contents in generated command arguments", () => {
    const command = buildPrivateCloudCommand("npm test");
    expect(command).toContain("python3 -I -S -u -c");
    expect(command).not.toContain("synthetic-database-secret");
    expect(command).not.toContain("exact output 🌍");
    expect(command).not.toContain(Buffer.from("exact output 🌍").toString("base64"));
  });
});
