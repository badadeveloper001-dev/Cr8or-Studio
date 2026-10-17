import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepositoryInitializationWire } from "../../src/lib/security/git-repository-initialization";

export const PILOT_REPOSITORY_KEY = "cr8or-verification/pilot-fixture";
export const PILOT_BRANCH = "pilot";
const roots = new Set<string>();
const fixtureEnvironment = Object.freeze({
  NODE_ENV: "test", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Synthetic Verification", GIT_AUTHOR_EMAIL: "verification@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Verification", GIT_COMMITTER_EMAIL: "verification@example.invalid",
});
const allowedScripts = ["typecheck", "lint", "test", "test:unit", "test:integration"] as const;

/** Fixed benign project code. The cancellation fixture creates a same-group
 * child and grandchild, each self-limited to 30 seconds. It neither accesses a
 * provider nor accepts a source/command parameter. This does not model a hostile
 * descendant that escapes its process group. */
const commandFixture = String.raw`const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args.length === 0) {
  if (Object.keys(process.env).some(k => /TOKEN|DATABASE|SECRET|API_KEY|OWNER_SESSION/.test(k))) process.exit(9);
  process.stdout.write("synthetic verification complete\n");
} else {
  const roles = ["parent", "child", "grandchild"];
  const role = args[0];
  if (args.length !== 1 || !roles.includes(role)) process.exit(8);
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  fs.writeFileSync("fixture-" + role + ".json", JSON.stringify({ pid: process.pid, startTime }), { flag: "wx" });
  const next = roles[roles.indexOf(role) + 1];
  if (next) spawn(process.execPath, [__filename, next], { stdio: "ignore", env: process.env });
  setTimeout(() => process.exit(0), 30000);
}
`;

export type PilotFixture = Readonly<{
  root: string; repositoryRoot: string; fixtureId: string;
  repositoryKey: typeof PILOT_REPOSITORY_KEY; branch: typeof PILOT_BRANCH;
  firstHead: string; head: string; graph: RepositoryInitializationWire;
  files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[];
}>;

/** Only new, local, randomly named fixtures are admitted by the offline process
 * adapter. No arbitrary path or historical workspace can be selected. */
export async function createOfflineSandbox(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-provider-offline-"));
  await fs.chmod(root, 0o700);
  roots.add(root);
  return root;
}

export function assertOfflineFixtureRoot(root: string): void {
  if (!roots.has(root) || realpathSync(root) !== root) throw new Error("Unknown offline fixture root.");
}

/** Inventory only: the runner preserves these disposable filesystem fixtures
 * for review. This function cannot delete, replace or adopt any resource. */
export function offlineFixtureInventory(): readonly string[] {
  return Object.freeze([...roots].sort());
}

function git(root: string, argv: readonly string[], date = "1700000000 +0000"): Buffer {
  assertOfflineFixtureRoot(path.dirname(root));
  try {
    return execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
      "-c", "credential.helper=", "-c", "core.fsmonitor=false", ...argv], {
      cwd: root, env: { ...fixtureEnvironment, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { throw new Error("Offline Git fixture creation failed."); }
}

/** Deterministic two-commit, complete SHA-1 history. No VFY number is invented:
 * subsequent numbered commits must be created by the real application helper. */
export async function createPilotFixture(): Promise<PilotFixture> {
  const root = await createOfflineSandbox();
  const repositoryRoot = path.join(root, "repo");
  await fs.mkdir(repositoryRoot, { mode: 0o700 });
  const entries: [string, Buffer][] = [
    ["empty.txt", Buffer.alloc(0)],
    ["binary.bin", Buffer.from([0, 1, 2, 127, 128, 254, 255, 13, 10])],
    ["source.txt", Buffer.from("synthetic initial source\n")],
    ["fixture.cjs", Buffer.from(commandFixture)],
    ["package.json", Buffer.from(JSON.stringify({ name: "cr8or-isolated-pilot", version: "1.0.0", private: true,
      scripts: Object.fromEntries(allowedScripts.map(key => [key, `node fixture.cjs${key === "test:integration" ? " parent" : ""}`])),
    }, null, 2) + "\n")],
  ];
  for (const [name, content] of entries) await fs.writeFile(path.join(repositoryRoot, name), content, { mode: 0o644, flag: "wx" });
  git(repositoryRoot, ["init", "--object-format=sha1", "--initial-branch=pilot"]);
  git(repositoryRoot, ["remote", "add", "origin", `https://github.com/${PILOT_REPOSITORY_KEY}.git`]);
  git(repositoryRoot, ["add", "--", ...entries.map(([name]) => name)]);
  git(repositoryRoot, ["commit", "--no-gpg-sign", "--no-verify", "-m", "Synthetic initial history"]);
  const firstHead = git(repositoryRoot, ["rev-parse", "HEAD"]).toString("ascii").trim();
  const unicode: [string, Buffer] = ["unicode-你好.txt", Buffer.from("Synthetic Unicode: café 你好 🌍\n")];
  entries.push(unicode);
  await fs.writeFile(path.join(repositoryRoot, unicode[0]), unicode[1], { mode: 0o644, flag: "wx" });
  git(repositoryRoot, ["add", "--", unicode[0]]);
  git(repositoryRoot, ["commit", "--no-gpg-sign", "--no-verify", "-m", "Synthetic compatible history"], "1700000060 +0000");
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]).toString("ascii").trim();
  const identifiers = [...new Set(git(repositoryRoot, ["rev-list", "--objects", "HEAD"]).toString("utf8").trim().split("\n").map(line => line.split(" ")[0]))].sort();
  if (identifiers.length > 128 || identifiers.some(oid => !/^[0-9a-f]{40}$/.test(oid))) throw new Error("Invalid offline fixture object inventory.");
  const objects = identifiers.map(oid => {
    const type = git(repositoryRoot, ["cat-file", "-t", oid]).toString("ascii").trim();
    if (type !== "blob" && type !== "tree" && type !== "commit") throw new Error("Unsupported offline fixture object.");
    const content = git(repositoryRoot, ["cat-file", type, oid]);
    if (createHash("sha1").update(`${type} ${content.length}\0`).update(content).digest("hex") !== oid) throw new Error("Invalid offline fixture object identity.");
    return Object.freeze({ oid, type, contentBase64: content.toString("base64") });
  });
  const graph: RepositoryInitializationWire = Object.freeze({ version: 1, repositoryKey: PILOT_REPOSITORY_KEY, branch: PILOT_BRANCH, head, objects: Object.freeze(objects) });
  return Object.freeze({ root, repositoryRoot, fixtureId: `pilot-v1-${head}`, repositoryKey: PILOT_REPOSITORY_KEY,
    branch: PILOT_BRANCH, firstHead, head, graph,
    files: Object.freeze(entries.map(([name, bytes]) => Object.freeze({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))),
  });
}

export type FixtureProcessEvidence = Readonly<{ role: "parent" | "child" | "grandchild"; pid: number; startTime: string; running: boolean }>;

/** Independent Linux observation, separate from the supervisor's confirmation.
 * PID reuse is rejected by comparing /proc start time; zombies are not running. */
export async function readFixtureProcessEvidence(root: string): Promise<readonly FixtureProcessEvidence[]> {
  assertOfflineFixtureRoot(root);
  const results: FixtureProcessEvidence[] = [];
  for (const role of ["parent", "child", "grandchild"] as const) {
    const file = path.join(root, "repo", `fixture-${role}.json`);
    let text: string;
    try { text = await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("Offline process evidence unavailable."); }
    if (Buffer.byteLength(text) > 256) throw new Error("Invalid offline process evidence.");
    const value = JSON.parse(text) as { pid: number; startTime: string };
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.startTime !== "string" || !/^\d{1,30}$/.test(value.startTime)) throw new Error("Invalid offline process evidence.");
    let running = false;
    try {
      const stat = await fs.readFile(`/proc/${value.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      running = fields[19] === value.startTime && fields[0] !== "Z" && fields[0] !== "X";
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Offline process evidence unavailable."); }
    results.push(Object.freeze({ role, ...value, running }));
  }
  return results;
}
