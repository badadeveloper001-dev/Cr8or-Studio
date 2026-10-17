import { z } from "zod";
import type { HarnessScenarioRecord } from "./types";

export const OFFLINE_CASES = Object.freeze({
  "AUTH-02": "A revoked genuine owner session cannot dispatch another operation.",
  "AUTH-05": "Scoped approval mismatches and repeat consumption reject in real PostgreSQL.",
  "FILE-01": "The fixed writer preserves the synthetic UTF-8 file SHA-256.",
  "FILE-02": "Unicode and line-ending bytes are preserved without normalization.",
  "FILE-03": "The fixed writer preserves an empty file.",
  "FILE-05": "A complete replacement preserves exact bytes.",
  "FILE-09": "Revocation detected before COMMIT preserves the original destination.",
  "CMD-01": "Approved benign catalogue commands run through the fixed supervisor.",
  "CMD-08": "Cancellation checks actual fixture descendants separately from session deletion.",
  "CMD-10": "Revocation stops subsequent command work and retains unconfirmed state.",
  "CMD-12": "Malformed completion cannot confirm success or permit duplicate dispatch.",
  "GIT-02": "Actual fixed-helper commits preserve sequential trusted test naming and history.",
  "GIT-03": "Controlled GitHub object transport retains exact Git object identities.",
  "GIT-05": "A non-force controlled branch update confirms the intended commit.",
  "GIT-11": "A lost mutation acknowledgment retains UNKNOWN without automatic retry.",
  "GIT-13": "Duplicate dispatch cannot consume an uncertain reservation.",
  "INIT-01": "Real source validation, filesystem helper and lifecycle registration compose.",
  "INIT-02": "Binary, empty and Unicode files retain exact bytes.",
  "INIT-03": "Independent repository inspection confirms complete history and HEAD.",
  "INIT-11": "Wrong repository source metadata cannot be accepted as initialization success.",
  "INIT-18": "Sequential replay cannot create a second registered workspace.",
  "LIFE-01": "Only the exact verified controlled resource can complete registration.",
  "LIFE-08": "A controlled timeout after creation retains UNKNOWN and the original resource identity.",
  "LIFE-02": "Registered state persists without implicit lifecycle mutations.",
  "SEC-03": "Every application release restriction rejects without a provider call.",
});

const factSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), head: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  bytes: z.number().int().min(0).max(2_097_152).optional(), objectCount: z.number().int().min(0).max(128).optional(),
  rejectedCount: z.number().int().min(0).max(10_000).optional(), dispatchCount: z.number().int().min(0).max(10_000).optional(),
  processCount: z.number().int().min(0).max(64).optional(), runningProcessCount: z.number().int().min(0).max(64).optional(),
  supervisorCancellationConfirmed: z.boolean().optional(), commitFrames: z.number().int().min(0).max(100).optional(),
  operationState: z.enum(["RESERVED", "DISPATCHED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN", "CANCELLED"]).optional(),
}).strict();
const recordSchema = z.object({
  testId: z.string().refine(value => Object.hasOwn(OFFLINE_CASES, value)),
  fixtureId: z.string().regex(/^(?:pilot-[a-z0-9-]{1,80}|[a-f0-9]{64})$/),
  status: z.enum(["PASS", "FAIL", "INCONCLUSIVE", "NOT RUN"]),
  observation: z.enum(["verified", "rejected", "uncertainty-retained", "unsupported", "not-executed", "assertion-failed", "interrupted"]),
  providerOperations: z.number().int().min(0).max(10_000),
  authorizationChecks: z.array(z.enum(["owner-session", "registered-project", "workspace-binding", "repository-binding",
    "agent-permission", "scoped-approval", "one-time-consumption", "session-revocation", "credential-generation",
    "durable-reservation", "release-restriction"])).max(11),
  cleanup: z.object({ sessions: z.enum(["CONFIRMED", "UNCONFIRMED", "NOT_APPLICABLE"]),
    processes: z.enum(["CONFIRMED", "UNCONFIRMED", "NOT_APPLICABLE"]) }).strict(),
  facts: factSchema.optional(),
}).strict();

export function createEvidence(applicationCommit: string, sdkVersion: string) {
  if (!/^[a-f0-9]{40}$/.test(applicationCommit) || !/^\d+\.\d+\.\d+$/.test(sdkVersion)) throw new Error("Invalid evidence baseline.");
  const rows = new Map<string, HarnessScenarioRecord>();
  const pending = new Set<string>();
  return {
    begin(testIds: readonly string[], fixtureId: string) {
      for (const testId of testIds) {
        const value: HarnessScenarioRecord = { testId, fixtureId, status: "INCONCLUSIVE", observation: "interrupted",
          providerOperations: 0, authorizationChecks: [], cleanup: { sessions: "UNCONFIRMED", processes: "UNCONFIRMED" } };
        if (!recordSchema.safeParse(value).success || rows.has(testId)) throw new Error("Invalid or duplicate evidence attempt.");
        rows.set(testId, value);
        pending.add(testId);
      }
    },
    record(value: HarnessScenarioRecord) {
      const parsed = recordSchema.safeParse(value);
      if (!parsed.success || (rows.has(value.testId) && !pending.has(value.testId))) throw new Error("Invalid or duplicate sanitized evidence record.");
      pending.delete(value.testId);
      rows.set(value.testId, Object.freeze(parsed.data));
    },
    failPendingAssertion() {
      for (const id of pending) {
        const row = rows.get(id)!;
        rows.set(id, Object.freeze({ ...row, status: "FAIL", observation: "assertion-failed" }));
      }
      pending.clear();
    },
    report() {
      return {
        version: 1, applicationCommit, sdkVersion, nodeVersion: process.version,
        executionKind: "OFFLINE_ADAPTER", liveProviderResult: "NOT RUN",
        notice: "NO LIVE PROVIDER TESTS PERFORMED.",
        coverage: "OFFLINE_CRITICAL_SUBSET",
        records: Object.entries(OFFLINE_CASES).map(([testId, expected]) => ({
          testId, expected, ...rows.get(testId), status: rows.get(testId)?.status ?? "NOT RUN",
          observed: rows.get(testId)?.observation ?? "not-executed",
          liveProviderResult: "NOT RUN",
          retainedResources: "LOCAL_FIXTURES_AND_TEST_DATABASE",
        })),
      };
    },
  };
}
