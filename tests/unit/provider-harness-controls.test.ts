import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertStandaloneEnvironment, OFFLINE_MANIFEST, validateOfflineManifest } from "../provider-verification/manifest";
import { createEvidence } from "../provider-verification/evidence";
import { resolveGitProjectCode, GIT_PROJECT_CODES } from "../provider-verification/naming";
import { Daytona } from "../provider-verification/blocked-sdk";
import { parseArguments } from "../../scripts/provider-verification.mjs";
import type { HarnessScenarioRecord } from "../provider-verification/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function cli(args: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "cr8or-harness-cli-")); roots.push(root);
  const out = await open(path.join(root, "stdout"), "wx", 0o600), err = await open(path.join(root, "stderr"), "wx", 0o600);
  let code: number | null;
  try {
    const child = spawn(process.execPath, ["--conditions=react-server", "scripts/provider-verification.mjs", ...args], {
      cwd: process.cwd(), env: { NODE_ENV: "test", PATH: process.env.PATH }, stdio: ["ignore", out.fd, err.fd],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
    finally { clearTimeout(timer); }
  } finally { await out.close(); await err.close(); }
  return { code, stdout: await readFile(path.join(root, "stdout"), "utf8"), stderr: await readFile(path.join(root, "stderr"), "utf8") };
}

describe("standalone harness admission and sanitized evidence", () => {
  it("accepts only the exact compiled offline manifest", () => {
    expect(validateOfflineManifest(JSON.parse(JSON.stringify(OFFLINE_MANIFEST)))).toEqual(OFFLINE_MANIFEST);
  });
  it.each([
    { mode: "live" }, { repository: "badadeveloper001-dev/cr8or-studio" }, { projectCode: "CR8OR" },
    { branch: "main" }, { maximumDurationSeconds: 301 }, { maximumProviderOperations: 10001 },
    { cleanup: "delete" }, { provider: "real" }, { approved: true }, { sandbox: "owner-history" },
    { sandboxes: ["offline-pilot-clone", "historical-resource"] },
  ])("rejects scope, resource, policy or release substitution %#", change => {
    expect(() => validateOfflineManifest({ ...OFFLINE_MANIFEST, ...change })).toThrow("compiled synthetic");
  });
  it.each(["GH_TOKEN", "GITHUB_TOKEN", "DAYTONA_API_KEY", "DATABASE_URL", "DIRECT_URL", "VERCEL", "NODE_OPTIONS", "NODE_PATH"])(
    "refuses inherited sensitive/deployed configuration %s", key => {
      expect(() => assertStandaloneEnvironment({ NODE_ENV: "test", [key]: "synthetic-marker" })).toThrow("fresh isolated");
    });
  it("refuses a production process and cannot construct a live SDK client", () => {
    expect(() => assertStandaloneEnvironment({ NODE_ENV: "production" })).toThrow();
    expect(() => new Daytona()).toThrow("Live provider construction");
  });
  it("test-only naming cannot authorize an application or caller-selected repository", () => {
    expect(GIT_PROJECT_CODES).toEqual({ "cr8or-verification/pilot-fixture": "VFY" });
    expect(resolveGitProjectCode("cr8or-verification/pilot-fixture")).toBe("VFY");
    expect(() => resolveGitProjectCode("badadeveloper001-dev/cr8or-studio")).toThrow();
    expect(() => resolveGitProjectCode("caller/choice")).toThrow();
  });
  it.each([{ args: ["--live"] }, { args: ["--run-offline", "--adapter", "real"] }, { args: ["--run-offline", "--manifest", "a", "--output", "b", "--allow-live"] }])(
    "does not accept a provider selector or gate override %#", ({ args }) => expect(() => parseArguments(args)).toThrow());

  const sample: HarnessScenarioRecord = { testId: "FILE-01", fixtureId: "pilot-synthetic", status: "PASS", observation: "verified",
    providerOperations: 8, authorizationChecks: ["owner-session", "workspace-binding"],
    cleanup: { sessions: "CONFIRMED", processes: "CONFIRMED" }, facts: { sha256: "a".repeat(64), bytes: 12 } };
  it("records an offline PASS without manufacturing a live PASS", () => {
    const evidence = createEvidence("a".repeat(40), "0.214.0");
    evidence.record(sample);
    expect(evidence.report().executionKind).toBe("OFFLINE_ADAPTER");
    expect(evidence.report().liveProviderResult).toBe("NOT RUN");
    expect(evidence.report().records.find(row => row.testId === "FILE-01")).toMatchObject({ status: "PASS", liveProviderResult: "NOT RUN" });
    expect(() => evidence.record(sample)).toThrow("duplicate");
  });
  it("retains an attempted but unconfirmed case distinctly from untouched cases", () => {
    const evidence = createEvidence("a".repeat(40), "0.214.0");
    evidence.begin(["FILE-01"], "pilot-synthetic");
    expect(evidence.report().records.find(row => row.testId === "FILE-01")).toMatchObject({ status: "INCONCLUSIVE", observed: "interrupted" });
    expect(evidence.report().records.find(row => row.testId === "FILE-02")).toMatchObject({ status: "NOT RUN" });
    evidence.record(sample);
    expect(evidence.report().records.find(row => row.testId === "FILE-01")?.status).toBe("PASS");
  });
  it("classifies a proved invariant violation as FAIL without retaining its error text", () => {
    const evidence = createEvidence("a".repeat(40), "0.214.0");
    evidence.begin(["FILE-01"], "pilot-synthetic");
    evidence.failPendingAssertion();
    expect(evidence.report().records.find(row => row.testId === "FILE-01")).toMatchObject({ status: "FAIL", observed: "assertion-failed" });
    expect(evidence.report().records.find(row => row.testId === "FILE-02")?.status).toBe("NOT RUN");
  });
  it.each([
    { token: "synthetic-secret" }, { observed: "provider-error-and-source" }, { fixtureId: "https://user:secret@provider" },
    { facts: { rawOutput: "synthetic-secret" } }, { facts: { sha256: "synthetic-secret" } },
    { testId: "invented-pass" }, { executionKind: "LIVE_PROVIDER" }, { providerOperations: -1 },
  ])("rejects secret-bearing or arbitrary evidence fields %#", change => {
    const evidence = createEvidence("a".repeat(40), "0.214.0");
    expect(() => evidence.record({ ...sample, ...change } as HarnessScenarioRecord)).toThrow("sanitized evidence");
    expect(JSON.stringify(evidence.report())).not.toContain("synthetic-secret");
  });
  it("describes the real CLI without PostgreSQL or provider credentials", async () => {
    const result = await cli(["--describe"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.mode).toBe("OFFLINE_ONLY");
    expect(output.manifest).toEqual(OFFLINE_MANIFEST);
    expect(output.liveResult).toBe("NOT RUN");
  });
  it("a manifest claiming live authorization cannot reach database setup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cr8or-harness-controls-")); roots.push(root);
    const manifest = path.join(root, "manifest.json"), output = path.join(root, "evidence.json");
    await writeFile(manifest, JSON.stringify({ ...OFFLINE_MANIFEST, mode: "live", approved: true }));
    expect(await cli(["--run-offline", "--manifest", manifest, "--output", output])).toMatchObject({ code: 1, stderr: expect.stringContaining("preflight") });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
