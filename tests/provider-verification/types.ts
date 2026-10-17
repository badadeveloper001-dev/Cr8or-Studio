import type { HarnessDatabase } from "./database";

export type VerificationStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT RUN";
export type AuthorizationCheck = "owner-session" | "registered-project" | "workspace-binding" | "repository-binding" |
  "agent-permission" | "scoped-approval" | "one-time-consumption" | "session-revocation" |
  "credential-generation" | "durable-reservation" | "release-restriction";
export type HarnessScenarioRecord = Readonly<{
  testId: string;
  fixtureId: string;
  status: VerificationStatus;
  observation: "verified" | "rejected" | "uncertainty-retained" | "unsupported" | "not-executed" | "assertion-failed" | "interrupted";
  providerOperations: number;
  authorizationChecks: readonly AuthorizationCheck[];
  cleanup: Readonly<{
    sessions: "CONFIRMED" | "UNCONFIRMED" | "NOT_APPLICABLE";
    processes: "CONFIRMED" | "UNCONFIRMED" | "NOT_APPLICABLE";
  }>;
  facts?: Readonly<{
    sha256?: string;
    head?: string;
    bytes?: number;
    objectCount?: number;
    rejectedCount?: number;
    dispatchCount?: number;
    processCount?: number;
    runningProcessCount?: number;
    supervisorCancellationConfirmed?: boolean;
    commitFrames?: number;
    operationState?: "RESERVED" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED";
  }>;
}>;

export type HarnessWorkflowContext = Readonly<{
  database: HarnessDatabase;
  root: string;
  begin: (testIds: readonly string[], fixtureId: string) => void;
  record: (value: HarnessScenarioRecord) => void;
}>;
