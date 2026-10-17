#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { readFile, open, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("../", import.meta.url));
const harness = resolve(root, "tests/provider-verification");
const HELP = `Standalone offline provider verification (Node.js 24).
Usage:
  node --conditions=react-server scripts/provider-verification.mjs --describe
  node --conditions=react-server scripts/provider-verification.mjs --run-offline --manifest tests/provider-verification/offline-manifest.json --output /tmp/new-provider-evidence.json

Only controlled offline adapters are available. No live mode or release override exists.
Set CR8OR_AUTH_TEST_DATABASE_URL to the disposable loopback test database on port 55432.
The runner creates a fresh synthetic schema and retains fixtures/database records.
Do not set DATABASE_URL, DIRECT_URL, provider credentials or deployment configuration.
NO LIVE PROVIDER TESTS PERFORMED.
`;

export function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  if (argv.length === 1 && argv[0] === "--describe") return { describe: true };
  if (argv.length !== 5 || argv[0] !== "--run-offline" || argv[1] !== "--manifest" || argv[3] !== "--output" ||
      !argv[2] || !argv[4] || argv[2].startsWith("--") || argv[4].startsWith("--")) {
    throw new Error("Invalid arguments; only the fixed offline runner is available.");
  }
  return { manifest: resolve(argv[2]), output: resolve(argv[4]) };
}

/** This fixed module graph is never selected by an HTTP request or model. */
function loader() {
  return createJiti(import.meta.url, { moduleCache: true, fsCache: false, alias: {
    "@/lib/security/git-project-naming": resolve(harness, "naming.ts"),
    "@daytona/sdk": resolve(harness, "blocked-sdk.ts"),
    "@": resolve(root, "src"),
    "server-only": fileURLToPath(import.meta.resolve("server-only")),
  } });
}

async function baseline() {
  const git = promisify(execFile);
  const options = { cwd: root, timeout: 5000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  const commit = (await git("git", ["rev-parse", "HEAD"], options)).stdout.trim();
  const dirty = (await git("git", ["status", "--porcelain"], options)).stdout.length !== 0;
  const sdk = JSON.parse(await readFile(resolve(root, "node_modules/@daytona/sdk/package.json"), "utf8")).version;
  return { commit, dirty, sdk };
}

/** Fresh child processes should use a minimal parent environment. Also discard
 * unrelated inherited values before loading any application/provider module. */
function isolateEnvironment(databaseUrl) {
  const paths = process.env.PATH;
  const temporary = process.env.TMPDIR;
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.PATH = paths ?? "/usr/bin:/bin";
  if (temporary) process.env.TMPDIR = temporary;
  process.env.NODE_ENV = "test";
  process.env.LANG = "C.UTF-8";
  process.env.CR8OR_AUTH_TEST_DATABASE_URL = databaseUrl;
  // No real HTTP transport can be used accidentally by an unprovided adapter.
  globalThis.fetch = async () => { throw new Error("Network fetch is unavailable in the offline harness."); };
}

async function verifyReleaseRestrictions(jiti, record) {
  for (const [file, names] of [
    ["private-cloud-write-availability", ["assertPrivateCloudWriteTransportAvailable"]],
    ["private-cloud-command-availability", ["assertPrivateCloudCommandAvailable"]],
    ["private-git-availability", ["assertPrivateGitAvailable"]],
    ["private-workspace-lifecycle-availability", ["assertWorkspaceLifecycleAvailable", "assertPrivateRepositoryCloningAvailable"]],
  ]) {
    const restriction = await jiti.import(resolve(root, `src/lib/workspace/${file}.ts`));
    for (const name of names) {
      let denied = false;
      try { restriction[name](); } catch (error) { denied = error?.status === 503; }
      if (!denied) throw new Error("A release restriction did not reject.");
    }
  }
  record({ testId: "SEC-03", fixtureId: "pilot-release-restrictions", status: "PASS", observation: "rejected",
    providerOperations: 0, authorizationChecks: ["release-restriction"],
    cleanup: { sessions: "NOT_APPLICABLE", processes: "NOT_APPLICABLE" }, facts: { rejectedCount: 5, dispatchCount: 0 } });
}

export async function main(argv = process.argv.slice(2)) {
  let database, output, evidence, jiti, phase = "preflight", schemaName = null, baselineData;
  let code = 0;
  try {
    const args = parseArguments(argv);
    if (args.help) { process.stdout.write(HELP); return 0; }
    if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node.js 24 is required.");
    jiti = loader();
    const manifests = await jiti.import(resolve(harness, "manifest.ts"));
    if (args.describe) {
      const { OFFLINE_CASES } = await jiti.import(resolve(harness, "evidence.ts"));
      process.stdout.write(`${JSON.stringify({ mode: "OFFLINE_ONLY", manifest: manifests.OFFLINE_MANIFEST,
        cases: OFFLINE_CASES, liveResult: "NOT RUN", notice: "NO LIVE PROVIDER TESTS PERFORMED." }, null, 2)}\n`);
      return 0;
    }
    manifests.assertStandaloneEnvironment(process.env);
    const manifestFile = await open(args.manifest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const metadata = await manifestFile.stat();
      if (!metadata.isFile() || metadata.size > 8192) throw new Error("Manifest is not a bounded regular file.");
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await manifestFile.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) throw new Error("Manifest is oversized.");
      bytes = buffer.subarray(0, bytesRead);
    } finally { await manifestFile.close(); }
    manifests.validateOfflineManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const { openHarnessDatabase, validateHarnessDatabaseUrl } = await jiti.import(resolve(harness, "database.ts"));
    const url = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
    validateHarnessDatabaseUrl(url);
    baselineData = await baseline();
    const { createEvidence } = await jiti.import(resolve(harness, "evidence.ts"));
    evidence = createEvidence(baselineData.commit, baselineData.sdk);
    // Exclusive creation; never overwrite or follow an evidence-file symlink.
    await mkdir(dirname(args.output), { recursive: true, mode: 0o700 });
    if (await realpath(dirname(args.output)) !== dirname(args.output)) throw new Error("Evidence parent must not be a symlink.");
    output = await open(args.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    isolateEnvironment(url);
    const { beginOfflineBudget } = await jiti.import(resolve(harness, "budget.ts"));
    beginOfflineBudget();
    phase = "database";
    database = await openHarnessDatabase(url);
    schemaName = database.schemaName;
    const record = (row) => {
      evidence.record(row);
      process.stderr.write(`[offline] ${row.testId}: ${row.status}\n`);
    };
    evidence.begin(["SEC-03"], "pilot-release-restrictions");
    await verifyReleaseRestrictions(jiti, record);
    // Git initialization must precede the separate command fixture registrations.
    phase = "git-workflow";
    const { runGitWorkflow } = await jiti.import(resolve(harness, "git-workflow.ts"));
    await runGitWorkflow({ database, root, record, begin: evidence.begin });
    phase = "execution-workflow";
    const { runExecutionWorkflow } = await jiti.import(resolve(harness, "execution-workflow.ts"));
    await runExecutionWorkflow({ database, root, record, begin: evidence.begin });
    phase = "complete";
  } catch (error) {
    code = 1;
    if (error?.code === "ERR_ASSERTION") evidence?.failPendingAssertion();
    if (/^provider_verification_[a-f0-9]{32}$/.test(error?.schemaName ?? "")) schemaName = error.schemaName;
    // Never print provider error bodies, SQL, source or credential-bearing URLs.
    process.stderr.write(`Offline harness stopped during ${phase}; unconfirmed operations and fixtures are retained.\n`);
  } finally {
    if (database) {
      try { await database.close(); } catch { code = 1; }
    }
    if (output && evidence) {
      const { offlineFixtureInventory } = await jiti.import(resolve(harness, "fixtures.ts"));
      const { snapshotOfflineBudget } = await jiti.import(resolve(harness, "budget.ts"));
      const report = evidence.report();
      if (report.records.some(row => row.status === "FAIL")) code = 1;
      const completed = code === 0;
      if (code === 0 && report.records.some(row => row.status !== "PASS")) code = 2;
      const payload = { ...report, completed, overallResult: code === 0 ? "PASS" : code === 2 ? "INCONCLUSIVE" : "FAIL", stoppedAt: phase,
        workingTreeDirty: baselineData?.dirty ?? true,
        manifestSha256: createHash("sha256").update(JSON.stringify((await jiti.import(resolve(harness, "manifest.ts"))).OFFLINE_MANIFEST)).digest("hex"),
        budget: snapshotOfflineBudget(),
        retainedInventory: { schemaName, localFixtureRoots: offlineFixtureInventory(), cleanup: "RETAINED_FOR_REVIEW" },
      };
      try { await output.writeFile(`${JSON.stringify(payload, null, 2)}\n`); await output.sync(); }
      catch { code = 1; }
      finally { await output.close(); }
      process.stdout.write(`${JSON.stringify({ completed, overallResult: code === 0 ? "PASS" : code === 2 ? "INCONCLUSIVE" : "FAIL", phase, offlineRecords: report.records.length,
        liveResult: "NOT RUN", notice: "NO LIVE PROVIDER TESTS PERFORMED." })}\n`);
    }
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
