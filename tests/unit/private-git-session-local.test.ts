import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGitOperationScope, parseGitOperation } from "@/lib/security/git-operation-catalogue";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { PRIVATE_GIT_PROGRAM } from "@/lib/workspace/private-git-program";
import { privateGitSession } from "@/lib/workspace/private-git-session";
import { createControlledDaytonaSessionAdapter } from "../helpers/daytona-session-adapter";

const execute = promisify(execFile);
let root: string;
let repo: string;
let adapter: ReturnType<typeof createControlledDaytonaSessionAdapter>;
const registration = { projectId: "local-disposable-fixture", workspace: {
  id: "synthetic-registration", runtimeType: "cloud" as const, provider: "daytona", providerWorkspaceId: "synthetic-daytona",
  repositoryUrl: "https://github.com/fixture/repo.git", branch: "main",
} };
async function git(...args: string[]) {
  return (await execute("git", args, { cwd: repo, env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Synthetic owner",
    GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Synthetic owner", GIT_COMMITTER_EMAIL: "test@example.invalid" } })).stdout.trim();
}
async function operation(value: unknown, validate: () => Promise<void> = async () => undefined) {
  const request = parseGitOperation(value);
  return privateGitSession(adapter, request, buildGitOperationScope(registration, request), validate, new AbortController().signal);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-git-session-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git("init", "-b", "main");
  await fs.writeFile(path.join(repo, "README.md"), "Synthetic initial contents\n");
  await git("add", "--", "README.md");
  await git("-c", "commit.gpgSign=false", "commit", "-m", "Initial fixture");
  await git("remote", "add", "origin", registration.workspace.repositoryUrl);
  adapter = createControlledDaytonaSessionAdapter(root);
  const owners = new Set([0, (await fs.stat("/usr/bin/git")).uid, (await fs.stat("/")).uid]);
  const program = PRIVATE_GIT_PROGRAM.replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${[...owners].join(",")},)`);
  const original = adapter.executeSessionCommand;
  adapter.executeSessionCommand = async (session, request, timeout) => {
    if (request.command !== `exec python3 -I -S -u -c ${shellQuote(PRIVATE_GIT_PROGRAM)}`) throw new Error("Unexpected test command");
    // Only trusted installation ownership is adapted to Codex's mapped UID.
    // This is actual Python/Git execution through a controlled local SDK shape,
    // not verification of live Daytona session, identity, network or isolation.
    return original(session, { ...request, command: `exec python3 -I -S -u -c ${shellQuote(program)}` }, timeout);
  };
});
afterEach(async () => {
  await adapter?.dispose();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("private Git protocol with real disposable repositories and controlled SDK sessions", () => {
  it("reads, stages and commits Unicode source content with exact expected state", async () => {
    await fs.mkdir(path.join(repo, "src"));
    const content = "export const label = '你好 🌍';\n";
    await fs.writeFile(path.join(repo, "src/label.ts"), content);
    const initial = await operation({ operation: "branch" });
    expect(initial.status).toBe("SUCCEEDED");
    const state = initial.data as { head: string; index: string };
    const staged = await operation({ operation: "stage", branch: "main", paths: ["src/label.ts"], expectedHead: state.head, expectedIndex: state.index });
    expect(staged.status).toBe("SUCCEEDED");
    const afterStage = staged.data as { head: string; index: string };
    const committed = await operation({ operation: "commit", branch: "main", expectedHead: afterStage.head,
      expectedIndex: afterStage.index, category: "Code improvements" });
    expect(committed).toMatchObject({ status: "SUCCEEDED", cancellationConfirmed: true, cleanupConfirmed: true,
      data: { title: "PROJECT-001: Code improvements" } });
    expect(await git("show", "HEAD:src/label.ts")).toBe(content.trim());
    expect(await fs.readFile(path.join(repo, "src/label.ts"), "utf8")).toBe(content);
    expect(adapter.activeCommands.size).toBe(0);
    for (const call of adapter.calls.commands) expect(call.request.command).not.toContain(content);
  });

  it("prevents a staged mutation when the owner is revoked before START", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "Changed but never staged\n");
    const initial = await operation({ operation: "branch" });
    const state = initial.data as { head: string; index: string };
    let checks = 0;
    const validate = async () => { if (++checks >= 4) throw new ExecutionAuthorizationError(401); };
    await expect(operation({ operation: "stage", branch: "main", paths: ["README.md"],
      expectedHead: state.head, expectedIndex: state.index }, validate)).rejects.toMatchObject({ status: 401 });
    expect(await git("diff", "--cached", "--name-only")).toBe("");
    expect(adapter.activeCommands.size).toBe(0);
  });

  it("rejects historical credential-bearing Git remotes without releasing their contents", async () => {
    await git("remote", "set-url", "origin", "https://synthetic-secret@github.com/fixture/repo.git");
    const result = await operation({ operation: "remote" });
    expect(result.status).toBe("FAILED");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(adapter.activeCommands.size).toBe(0);
  });
});
