import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PRIVATE_GIT_LIMITS, PRIVATE_GIT_PROGRAM } from "@/lib/workspace/private-git-program";

const execute = promisify(execFile);
const repository = "https://github.com/example/registered.git";
let root: string;
let repo: string;

type Receipt = { ok: boolean; error?: string; data?: Record<string, unknown> };
type Request = Record<string, unknown>;
type Options = {
  program?: string;
  wire?: string;
  control?: string | null;
  onReady?: () => Promise<void>;
  environment?: Record<string, string>;
};

async function git(...args: string[]): Promise<string> {
  const result = await execute("git", args, {
    cwd: repo,
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Synthetic Test Owner",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic Test Owner",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return result.stdout.trim();
}

async function run(request: Request, options: Options = {}): Promise<Receipt & { output: string; stderr: string }> {
  // Only the disposable harness adapts the readonly installation's remapped
  // UID. The production helper trusts root-owned Git and has no env override.
  const owners = new Set([0, (await fs.stat("/usr/bin/git")).uid, (await fs.stat("/")).uid]);
  const program = (options.program ?? PRIVATE_GIT_PROGRAM)
    .replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${[...owners].join(",")},)`);
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", "-S", "-c", program], {
      cwd: root,
      env: { NODE_ENV: "test", PATH: process.env.PATH, ...options.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    let ready = false;
    let failure: unknown;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Git helper test exceeded its deadline"));
    }, 8_000);
    child.stdin.on("error", () => undefined);
    child.on("error", reject);
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (!ready && output.includes("CR8OR-GIT/1 READY\n")) {
        ready = true;
        void (async () => {
          try {
            await options.onReady?.();
            if (options.control === null) child.stdin.end();
            else child.stdin.write(options.control ?? "START\n");
          } catch (error) {
            failure = error;
            child.kill("SIGKILL");
          }
        })();
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      const line = output.split("\n").find((value) => value.startsWith("CR8OR-GIT/1 RESULT "));
      if (!line) { reject(new Error(`Missing sanitized helper receipt: ${stderr}`)); return; }
      resolve({ ...JSON.parse(line.slice("CR8OR-GIT/1 RESULT ".length)) as Receipt, output, stderr });
    });
    child.stdin.write(options.wire ?? `${JSON.stringify({ expectedRepository: repository, branch: "main", ...request })}\n`);
  });
}

async function snapshot(): Promise<{ expectedHead: string; branch: string; expectedIndex: string }> {
  const result = await run({ operation: "branch" });
  expect(result.ok, result.output).toBe(true);
  return {
    expectedHead: result.data!.head as string,
    branch: result.data!.branch as string,
    expectedIndex: result.data!.index as string,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-private-git-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git("init", "-b", "main");
  await fs.writeFile(path.join(repo, "README.md"), "initial\n");
  await git("add", "--", "README.md");
  await git("-c", "commit.gpgSign=false", "commit", "-m", "Synthetic initial history");
  await git("remote", "add", "origin", repository);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("fixed-purpose Git helper with disposable real repositories", () => {
  it("reads status, branch, changes, diff, neutral history and credential-free remote metadata", async () => {
    const initial = await snapshot();
    expect(initial.branch).toBe("main");
    await fs.writeFile(path.join(repo, "README.md"), "exact Unicode 🌍\r\n");
    const status = await run({ operation: "status" });
    expect(status).toMatchObject({ ok: true, data: { branch: "main", changes: [{ status: " M", path: "README.md" }] } });
    expect(await run({ operation: "changes" })).toMatchObject({ ok: true, data: status.data });
    const diff = await run({ operation: "diff", paths: ["README.md"] });
    expect(diff).toMatchObject({ ok: true, data: { staged: "" } });
    expect(diff.data!.unstaged).toContain("+exact Unicode 🌍\r\n");
    const log = await run({ operation: "log" });
    expect(log).toMatchObject({ ok: true, data: { commits: [{ sha: initial.expectedHead, title: "Commit" }] } });
    expect(await run({ operation: "remote" })).toMatchObject({ ok: true, data: { name: "origin", url: repository } });
  });

  it("stages and unstages exact literal file paths while preserving content and history", async () => {
    const name = "literal$(touch injected);file.txt";
    const content = "Unicode 🧪\r\n\0content\n";
    await fs.writeFile(path.join(repo, name), content);
    const before = await snapshot();
    expect(await run({ operation: "stage", paths: [name], ...before })).toMatchObject({ ok: true, data: { head: before.expectedHead, operation: "stage" } });
    expect(await git("diff", "--cached", "--name-only")).toBe(name);
    expect(await fs.readFile(path.join(repo, name), "utf8")).toBe(content);
    expect(await run({ operation: "unstage", paths: [name], ...await snapshot() })).toMatchObject({ ok: true });
    expect(await git("diff", "--cached", "--name-only")).toBe("");
    await expect(fs.stat(path.join(repo, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates neutral sequential commits, preserves parent history and rejects duplicate dispatch", async () => {
    const parent = await git("rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "README.md"), "changed\n");
    expect(await run({ operation: "stage", paths: ["README.md"], ...await snapshot() })).toMatchObject({ ok: true });
    const request = { operation: "commit", commitPrefix: "PROJECT", category: "Code improvements", ...await snapshot() };
    const result = await run(request);
    expect(result).toMatchObject({ ok: true, data: { title: "PROJECT-001: Code improvements" } });
    expect(await git("rev-parse", "HEAD^")).toBe(parent);
    expect(await git("log", "-1", "--format=%s")).toBe("PROJECT-001: Code improvements");
    expect(await run(request)).toMatchObject({ ok: false, error: "CONFLICT" });
    await fs.writeFile(path.join(repo, "README.md"), "second change\n");
    expect(await run({ operation: "stage", paths: ["README.md"], ...await snapshot() })).toMatchObject({ ok: true });
    expect(await run({ operation: "commit", commitPrefix: "PROJECT", category: "Test improvements", ...await snapshot() })).toMatchObject({ ok: true, data: { title: "PROJECT-002: Test improvements" } });
  });

  it("suppresses repository hooks and does not forward application secrets to Git", async () => {
    const marker = path.join(root, "hook-executed");
    await fs.writeFile(path.join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho unsafe > '${marker}'\n`, { mode: 0o755 });
    await fs.writeFile(path.join(repo, "README.md"), "change\n");
    expect(await run({ operation: "stage", paths: ["README.md"], ...await snapshot() })).toMatchObject({ ok: true });
    expect(await run({ operation: "commit", commitPrefix: "PROJECT", category: "General maintenance", ...await snapshot() }, {
      environment: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: path.join(repo, ".git", "hooks"), GIT_TRACE: "1", DATABASE_URL: "postgresql://synthetic-secret", GITHUB_TOKEN: "synthetic-provider-secret" },
    })).toMatchObject({ ok: true, stderr: "" });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../outside", "/tmp/outside", "-u", ":(top)*", ".git/config", "nested/../../outside", "nested\\outside", ".env.production", ".npmrc", "private.pem", ".gitattributes", ".gitmodules"])("rejects unsafe path %j before mutation", async (file) => {
    const before = await snapshot();
    expect(await run({ operation: "stage", paths: [file], ...before })).toMatchObject({ ok: false, error: "REJECTED" });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["-branch", "main;touch injected", "main$(id)", "../main", "refs/heads/main:evil", "main.lock"])("rejects unsafe or substituted branch %j", async (branch) => {
    expect(await run({ operation: "stage", paths: ["README.md"], ...await snapshot(), branch })).toMatchObject({ ok: false });
  });

  it("rejects arbitrary operation, extra command arguments, working directory and client commit title", async () => {
    for (const request of [
      { operation: "push" },
      { operation: "status", args: ["--exec=bad"] },
      { operation: "status", cwd: "../outside" },
      { operation: "status", environment: { GIT_CONFIG_COUNT: "1" } },
      { operation: "commit", ...await snapshot(), commitPrefix: "PROJECT", category: "Sensitive implementation detail" },
      { operation: "commit", ...await snapshot(), commitPrefix: "CUSTOM", category: "General maintenance" },
    ]) expect(await run(request)).toMatchObject({ ok: false, error: "REJECTED" });
  });

  it.each([
    '[include]\n path = /tmp/hostile',
    '[core]\n hooksPath = /tmp/hostile',
    '[core]\n fsmonitor = /tmp/hostile',
    '[core]\n worktree = /tmp/outside',
    '[filter "attack"]\n clean = touch /tmp/injected',
    '[diff "attack"]\n textconv = touch /tmp/injected',
    '[credential]\n helper = !touch /tmp/injected',
    '[url "https://token@example.invalid/"]\n insteadOf = https://github.com/',
    '[extensions]\n objectformat = sha256',
  ])("rejects unsafe repository configuration without leaking its value (%s)", async (config) => {
    await fs.appendFile(path.join(repo, ".git", "config"), `\n${config}\n`);
    const result = await run({ operation: "status" });
    expect(result).toMatchObject({ ok: false, error: "REJECTED", stderr: "" });
    expect(result.output).not.toContain("hostile");
    expect(result.output).not.toContain("token");
  });

  it.each(["https://secret-token@github.com/example/registered.git", "git@github.com:example/registered.git", "https://github.com/example/other.git", "https://example.invalid/example/registered.git"])("rejects credential-bearing or mismatched remote %s", async (remote) => {
    await git("remote", "set-url", "origin", remote);
    const result = await run({ operation: "remote" });
    expect(result).toMatchObject({ ok: false, error: "REJECTED" });
    expect(result.output).not.toContain(remote);
  });

  it.each(["objects/info/alternates", "objects/info/http-alternates", "info/grafts", "info/attributes", "config.worktree", "shallow"])("rejects unsupported metadata indirection %s", async (file) => {
    await fs.writeFile(path.join(repo, ".git", file), "/outside/object-store\n");
    expect(await run({ operation: "status" })).toMatchObject({ ok: false, error: "REJECTED" });
  });

  it.each(["symlink", "hardlink", "directory symlink", "attributes"])("rejects %s paths before reading or staging outside content", async (kind) => {
    const outside = path.join(root, "outside-secret");
    await fs.writeFile(outside, "synthetic outside secret");
    const before = await snapshot();
    if (kind === "symlink") await fs.symlink(outside, path.join(repo, "linked"));
    if (kind === "hardlink") await fs.link(outside, path.join(repo, "linked"));
    if (kind === "directory symlink") await fs.symlink(root, path.join(repo, "linked"), "dir");
    if (kind === "attributes") await fs.writeFile(path.join(repo, ".gitattributes"), "* filter=attack\n");
    const result = await run({ operation: "stage", paths: ["README.md"], ...before });
    expect(result).toMatchObject({ ok: false, error: "REJECTED" });
    expect(result.output).not.toContain("synthetic outside secret");
    expect(await fs.readFile(outside, "utf8")).toBe("synthetic outside secret");
  });

  it("rejects replacement repository roots and .git symlinks", async () => {
    await fs.rename(repo, path.join(root, "original"));
    await fs.symlink(path.join(root, "original"), repo, "dir");
    expect(await run({ operation: "status" })).toMatchObject({ ok: false, error: "REJECTED" });
    await fs.unlink(repo);
    await fs.rename(path.join(root, "original"), repo);
    await fs.rename(path.join(repo, ".git"), path.join(root, "git-original"));
    await fs.symlink(path.join(root, "git-original"), path.join(repo, ".git"), "dir");
    expect(await run({ operation: "status" })).toMatchObject({ ok: false, error: "REJECTED" });
  });

  it("rechecks HEAD and index after READY before mutation", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "change\n");
    const before = await snapshot();
    const result = await run({ operation: "stage", paths: ["README.md"], ...before }, {
      onReady: async () => { await git("add", "--", "README.md"); },
    });
    expect(result).toMatchObject({ ok: false, error: "CONFLICT" });
    expect(await git("rev-parse", "HEAD")).toBe(before.expectedHead);
  });

  it("binds reads to the registered repository and branch", async () => {
    expect(await run({ operation: "status", expectedRepository: "https://github.com/example/unregistered.git" })).toMatchObject({ ok: false, error: "REJECTED" });
    expect(await run({ operation: "status", branch: "another-branch" })).toMatchObject({ ok: false, error: "CONFLICT" });
    await git("checkout", "-b", "another-branch");
    expect(await run({ operation: "diff", paths: ["README.md"] })).toMatchObject({ ok: false, error: "CONFLICT" });
  });

  it("revalidates configuration after authorization before even a read subprocess", async () => {
    const result = await run({ operation: "status" }, {
      onReady: async () => { await fs.appendFile(path.join(repo, ".git", "config"), '\n[include]\n path = /outside/sensitive-config\n'); },
    });
    expect(result).toMatchObject({ ok: false, error: "REJECTED", stderr: "" });
    expect(result.output).not.toContain("sensitive-config");
  });

  it.each(["root", "metadata"])("rejects %s replacement between authorization and dispatch", async (target) => {
    const result = await run({ operation: "status" }, {
      onReady: async () => {
        if (target === "root") {
          await fs.rename(repo, path.join(root, "original-repo"));
          await fs.mkdir(repo);
        } else {
          await fs.rename(path.join(repo, ".git"), path.join(root, "original-git"));
          await fs.mkdir(path.join(repo, ".git"));
        }
      },
    });
    expect(result).toMatchObject({ ok: false, error: "CONFLICT" });
  });

  it("refuses overlapping operations using an actual repository-local advisory lock", async () => {
    let concurrent: Receipt | undefined;
    const first = await run({ operation: "status" }, {
      onReady: async () => { concurrent = await run({ operation: "status" }); },
    });
    expect(concurrent).toMatchObject({ ok: false, error: "BUSY" });
    expect(first).toMatchObject({ ok: true });
    expect(await run({ operation: "status" })).toMatchObject({ ok: true });
  });

  it.each(["CANCEL\n", null])("cancels before START without changing the index (%j)", async (control) => {
    const before = await snapshot();
    await fs.writeFile(path.join(repo, "README.md"), "change\n");
    expect(await run({ operation: "stage", paths: ["README.md"], ...before }, { control })).toMatchObject({ ok: false, error: "CANCELLED" });
    expect(await snapshot()).toEqual(before);
    expect(await git("diff", "--cached", "--name-only")).toBe("");
  });

  it("rejects incomplete, oversized and pipelined request frames predictably", async () => {
    expect(await run({}, { wire: "{" + "x".repeat(PRIVATE_GIT_LIMITS.requestBytes) + "\n" })).toMatchObject({ ok: false, error: "LIMIT" });
    expect(await run({}, { wire: "not JSON\n" })).toMatchObject({ ok: false, error: "REJECTED" });
    expect(await run({}, { wire: `${JSON.stringify({ operation: "status", expectedRepository: repository, branch: "main" })}\nSTART\n` })).toMatchObject({ ok: false, error: "REJECTED" });
  });

  it("bounds output instead of silently returning a truncated source diff", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "large source\n".repeat(30_000));
    const result = await run({ operation: "diff", paths: ["README.md"] });
    expect(result).toMatchObject({ ok: false, error: "LIMIT" });
    expect(result.output).not.toContain("large source");
    expect(result.output.length).toBeLessThan(200);
  });

  it("enforces the helper deadline while waiting for authorization", async () => {
    const result = await run({ operation: "status" }, {
      program: PRIVATE_GIT_PROGRAM.replace("MAX_SECONDS=30", "MAX_SECONDS=1"),
      onReady: async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); },
    });
    expect(result).toMatchObject({ ok: false, error: "LIMIT" });
  });

  it("never reports success when process-group termination cannot be confirmed", async () => {
    // The real Git subprocess runs and exits. This disposable harness injects
    // an OS permission failure only for the process-group existence probe,
    // proving that leader exit alone is insufficient for a success receipt.
    const program = PRIVATE_GIT_PROGRAM.replace("def kill_child():", String.raw`
real_killpg=os.killpg
def denied_group_probe(pid,event):
    if event==0: raise PermissionError()
    return real_killpg(pid,event)
os.killpg=denied_group_probe
def kill_child():`);
    const result = await run({ operation: "status" }, { program });
    expect(result).toMatchObject({ ok: false, error: "UNCERTAIN", stderr: "" });
    expect(result.output).not.toContain('"ok":true');
    expect(await run({ operation: "status" })).toMatchObject({ ok: true });
  });

  it("keeps staged sensitive files out of a commit and preserves the existing HEAD", async () => {
    const previous = await git("rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, ".env.production"), "SYNTHETIC_SECRET=value\n");
    await git("add", "--", ".env.production");
    const result = await run({ operation: "commit", commitPrefix: "PROJECT", category: "General maintenance", ...await snapshot() });
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("SYNTHETIC_SECRET");
    expect(await git("rev-parse", "HEAD")).toBe(previous);
  });
});
