import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ToolContext } from "@/lib/agents/tools";
import { createPrivateCommandApproval, decidePrivateCommandApproval } from "@/lib/security/command-approvals";
import { authorizeDevelopmentCommand } from "@/lib/security/command-authorization";
import { readCommandOperation } from "@/lib/security/command-operation-store";
import { createExecutionAuthorization, ExecutionAuthorizationError, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { getPolicyProfile, setPolicyProfile } from "@/lib/security/policy";
import { revokeSession } from "@/lib/security/session-store";
import { privateCloudCommandSession } from "@/lib/workspace/private-cloud-command-session";
import { privateCloudWriteSession } from "@/lib/workspace/private-cloud-write-session";
import type { ValidatedCommandRequest } from "@/lib/workspace/runtime";

import { createPilotFixture, readFixtureProcessEvidence, type PilotFixture } from "./fixtures";
import { createOfflineSessionAdapter } from "./session-adapter";
import type { HarnessScenarioRecord, HarnessWorkflowContext } from "./types";

const identities = Object.freeze({
  ordinary: { project: "offline-execution-project", sandbox: "offline-pilot-execution" },
  cancellation: { project: "offline-cancellation-project", sandbox: "offline-pilot-cancellation" },
  uncertain: { project: "offline-uncertain-command-project", sandbox: "offline-pilot-uncertain-command" },
});
type Adapter = ReturnType<typeof createOfflineSessionAdapter>;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const authorizationChecks = ["owner-session", "registered-project", "workspace-binding"] as const;

async function denied(work: () => Promise<unknown>, statuses: number[] = [401, 403, 409, 503]): Promise<void> {
  await assert.rejects(work, error => error instanceof ExecutionAuthorizationError && statuses.includes(error.status));
}

/** This is an offline composition seam, not a runtime availability switch. The
 * real session resolver, opaque contexts, approvals and PostgreSQL reservations
 * remain authoritative. Only the provider transport is a fixed local adapter. */
export async function runExecutionWorkflow({ database, record, begin }: HarnessWorkflowContext): Promise<void> {
  const previousPolicy = getPolicyProfile();
  setPolicyProfile("balanced");
  const adapters: Adapter[] = [];
  const adapterFor = (fixture: PilotFixture, options?: Parameters<typeof createOfflineSessionAdapter>[1]) => {
    const adapter = createOfflineSessionAdapter(fixture.root, options);
    adapters.push(adapter);
    return adapter;
  };
  const register = async (fixture: PilotFixture, identity: typeof identities[keyof typeof identities]) => {
    await database.prisma.project.create({ data: {
      id: identity.project, name: "Synthetic offline provider fixture", description: "Disposable verification only",
      framework: "Node.js", language: "JavaScript", repository: fixture.repositoryKey,
      workspaces: { create: { id: `${identity.project}-registration`, runtimeType: "cloud", state: "running",
        provider: "daytona", providerWorkspaceId: identity.sandbox,
        repositoryUrl: `https://github.com/${fixture.repositoryKey}.git`, branch: fixture.branch } },
    } });
  };
  const capability = async (projectId: string, signal?: AbortSignal) => {
    const initiating = await database.createSession();
    const authorization = await createExecutionAuthorization(initiating.session, projectId, { signal });
    assert.ok(authorization);
    return { ...initiating, authorization };
  };
  const toolContext = (fixture: PilotFixture, authorization: ExecutionAuthorizationContext, approvalId?: string): ToolContext => ({
    authorization, projectId: authorization.projectId, workspaceRoot: fixture.repositoryRoot,
    actorId: "frontend", actorRole: "agent", requestId: randomUUID(), approvalId,
  });
  const approve = async (initiating: Awaited<ReturnType<typeof capability>>, command: string) => {
    const approval = await createPrivateCommandApproval(initiating.authorization, command);
    const decided = await decidePrivateCommandApproval(initiating.session, approval.id, "approved");
    assert.equal(decided?.status, "approved");
    return approval.id;
  };
  const commandRequest = async (fixture: PilotFixture, initiating: Awaited<ReturnType<typeof capability>>, command: string) => {
    const approvalId = await approve(initiating, command);
    const result = await authorizeDevelopmentCommand(toolContext(fixture, initiating.authorization, approvalId), command);
    assert.ok(result.allowed);
    return { command, commandKey: command, rules: [{ kind: "exact", value: command }], timeoutMs: 60_000,
      commandAuthorization: result.authorization } satisfies ValidatedCommandRequest;
  };
  const emit = (testId: string, fixtureId: string, adapter: Adapter | undefined,
    values: Pick<HarnessScenarioRecord, "status" | "observation"> & Partial<Pick<HarnessScenarioRecord, "authorizationChecks" | "facts" | "cleanup">>) => {
    const evidence = adapter?.evidence();
    record({ testId, fixtureId, status: values.status, observation: values.observation,
      providerOperations: evidence?.providerOperations ?? 0, authorizationChecks: values.authorizationChecks ?? authorizationChecks,
      cleanup: values.cleanup ?? { sessions: evidence ? evidence.openSessions === 0 ? "CONFIRMED" : "UNCONFIRMED" : "NOT_APPLICABLE",
        processes: evidence ? evidence.helpersStillRunning === 0 ? "CONFIRMED" : "UNCONFIRMED" : "NOT_APPLICABLE" },
      ...(values.facts ? { facts: values.facts } : {}),
    });
  };

  try {
    const fixture = await createPilotFixture();
    const identity = identities.ordinary;
    await register(fixture, identity);
    const initiating = await capability(identity.project);

    for (const [id, relative, content] of [
      ["FILE-01", "ordinary.txt", "Synthetic provider verification\n"],
      ["FILE-02", "unicode-transfer.txt", "a".repeat(12_287) + "🌍e\u0301你好\r\n\0end"],
      ["FILE-03", "source.txt", ""],
    ] as const) {
      begin([id], fixture.fixtureId);
      const adapter = adapterFor(fixture);
      const beforeSibling = digest(await readFile(path.join(fixture.repositoryRoot, "binary.bin")));
      const result = await privateCloudWriteSession(adapter, identity.project, identity.sandbox, relative, content, initiating.authorization);
      const bytes = await readFile(path.join(fixture.repositoryRoot, relative));
      assert.equal(result.bytes, Buffer.byteLength(content));
      assert.equal(digest(bytes), digest(content));
      assert.equal(digest(await readFile(path.join(fixture.repositoryRoot, "binary.bin"))), beforeSibling);
      if (id === "FILE-03") {
        await privateCloudWriteSession(adapter, identity.project, identity.sandbox, "created-empty.txt", "", initiating.authorization);
        assert.equal((await readFile(path.join(fixture.repositoryRoot, "created-empty.txt"))).length, 0);
      }
      emit(id, fixture.fixtureId, adapter, { status: "PASS", observation: "verified", facts: { sha256: digest(bytes), bytes: bytes.length } });
    }

    // A bounded independent observer may see only whole old/new snapshots. It
    // is evidence for this temporary filesystem, never Daytona atomicity proof.
    {
      begin(["FILE-05"], fixture.fixtureId);
      const adapter = adapterFor(fixture);
      const target = path.join(fixture.repositoryRoot, "ordinary.txt");
      const oldDigest = digest(await readFile(target));
      const replacement = "Synthetic atomic replacement\n".repeat(128);
      const newDigest = digest(replacement);
      const seen = new Set([oldDigest]);
      let observing = true;
      const observer = (async () => {
        for (let count = 0; count < 5_000 && observing; count++) {
          seen.add(digest(await readFile(target)));
          await new Promise(resolve => setTimeout(resolve, 2));
        }
      })();
      try { await privateCloudWriteSession(adapter, identity.project, identity.sandbox, "ordinary.txt", replacement, initiating.authorization); }
      finally { observing = false; await observer; }
      seen.add(digest(await readFile(target)));
      assert.equal(digest(await readFile(target)), newDigest);
      assert.ok([...seen].every(value => value === oldDigest || value === newDigest));
      emit("FILE-05", fixture.fixtureId, adapter, { status: "PASS", observation: "verified", facts: { sha256: newDigest, bytes: Buffer.byteLength(replacement) } });
    }

    {
      begin(["FILE-09"], fixture.fixtureId);
      const revocable = await capability(identity.project);
      let staged = false;
      const adapter = adapterFor(fixture, { onStaged: async () => { staged = true; await revokeSession(revocable.sessionId); } });
      const before = digest(await readFile(path.join(fixture.repositoryRoot, "ordinary.txt")));
      await denied(() => privateCloudWriteSession(adapter, identity.project, identity.sandbox, "ordinary.txt", "Rejected synthetic replacement", revocable.authorization), [401]);
      assert.ok(staged);
      assert.equal(digest(await readFile(path.join(fixture.repositoryRoot, "ordinary.txt"))), before);
      assert.equal(adapter.evidence().commitFrames, 0);
      emit("FILE-09", fixture.fixtureId, adapter, { status: "PASS", observation: "rejected",
        authorizationChecks: [...authorizationChecks, "session-revocation"], facts: { sha256: before, dispatchCount: 0, commitFrames: adapter.evidence().commitFrames } });
      begin(["AUTH-02"], fixture.fixtureId);
      const providerCallsBefore = adapter.evidence().providerOperations;
      await denied(() => privateCloudWriteSession(adapter, identity.project, identity.sandbox, "ordinary.txt", "Revoked follow-up", revocable.authorization), [401]);
      await denied(() => authorizeDevelopmentCommand(toolContext(fixture, revocable.authorization), "npm run lint"), [401]);
      assert.equal(adapter.evidence().providerOperations, providerCallsBefore);
      assert.equal(digest(await readFile(path.join(fixture.repositoryRoot, "ordinary.txt"))), before);
      // This record counts the rejected follow-up attempts, not the earlier
      // transfer that reached STAGED. Expiry/rotation variants remain deferred.
      emit("AUTH-02", fixture.fixtureId, undefined, { status: "PASS", observation: "rejected",
        authorizationChecks: [...authorizationChecks, "session-revocation"], facts: { rejectedCount: 2, dispatchCount: 0 } });
    }

    // Two concurrently submitted transactions contend on the real approval row.
    // This is one process/one pool: cross-instance AUTH-06 remains NOT RUN.
    {
      begin(["AUTH-05"], fixture.fixtureId);
      const approvalId = await approve(initiating, "npm run lint");
      const context = toolContext(fixture, initiating.authorization, approvalId);
      // Fabricating an owner-looking role does not change the server actor tier.
      await denied(() => authorizeDevelopmentCommand({ ...context, actorId: "main-chat", actorRole: "owner" }, "npm run lint"), [403]);
      assert.equal((await authorizeDevelopmentCommand(context, "npm test")).allowed, false);
      const consumed = await Promise.all([
        authorizeDevelopmentCommand(context, "npm run lint"),
        authorizeDevelopmentCommand(context, "npm run lint"),
      ]);
      assert.equal(consumed.filter(value => value.allowed).length, 1);
      assert.equal((await authorizeDevelopmentCommand(context, "npm run lint")).allowed, false);
      const persisted = await database.prisma.commandApproval.findUniqueOrThrow({ where: { id: approvalId } });
      assert.ok(persisted.consumedAt);
      emit("AUTH-05", fixture.fixtureId, undefined, { status: "PASS", observation: "verified",
        authorizationChecks: [...authorizationChecks, "agent-permission", "scoped-approval", "one-time-consumption"], facts: { rejectedCount: 4, dispatchCount: 0 } });
    }

    {
      begin(["CMD-01"], fixture.fixtureId);
      const adapter = adapterFor(fixture);
      const commandNames = ["npm run typecheck", "npm run lint", "npm test", "npm run test:unit"];
      for (const command of commandNames) {
        const request = await commandRequest(fixture, initiating, command);
        const result = await privateCloudCommandSession(adapter, identity.project, identity.sandbox, request, initiating.authorization);
        assert.equal(result.exitCode, 0);
        assert.equal(result.status, "succeeded");
        assert.equal(result.cancellationConfirmed, true);
        assert.equal((await readCommandOperation(result.operationId!))?.status, "SUCCEEDED");
      }
      emit("CMD-01", fixture.fixtureId, adapter, { status: "PASS", observation: "verified",
        authorizationChecks: [...authorizationChecks, "agent-permission", "scoped-approval", "one-time-consumption", "durable-reservation"],
        facts: { dispatchCount: commandNames.length, operationState: "SUCCEEDED" } });
    }

    {
      const cancelFixture = await createPilotFixture();
      begin(["CMD-08", "CMD-10"], cancelFixture.fixtureId);
      const cancelIdentity = identities.cancellation;
      await register(cancelFixture, cancelIdentity);
      const revocable = await capability(cancelIdentity.project);
      let revoked = false;
      let observedBefore = 0;
      const adapter = adapterFor(cancelFixture, { onPoll: async () => {
        const processes = await readFixtureProcessEvidence(cancelFixture.root);
        if (!revoked && processes.length === 3 && processes.every(item => item.running)) {
          observedBefore = processes.length;
          await revokeSession(revocable.sessionId);
          revoked = true;
        }
      } });
      const request = await commandRequest(cancelFixture, revocable, "npm run test:integration");
      await denied(() => privateCloudCommandSession(adapter, cancelIdentity.project, cancelIdentity.sandbox, request, revocable.authorization));
      assert.ok(revoked, "The bounded descendant fixture must start before revocation.");
      const observedAfter = await readFixtureProcessEvidence(cancelFixture.root);
      assert.equal(observedBefore, 3);
      const operation = await database.prisma.commandOperation.findFirstOrThrow({ where: { projectId: cancelIdentity.project } });
      const independentlyStopped = observedAfter.length === 3 && observedAfter.every(item => !item.running);
      const confirmed = independentlyStopped && operation.cancellationConfirmed && operation.cleanupConfirmed && operation.status === "CANCELLED";
      assert.ok(operation.status === "CANCELLED" || operation.status === "UNKNOWN");
      const values = { status: confirmed ? "PASS" : "INCONCLUSIVE", observation: confirmed ? "verified" : "uncertainty-retained",
        authorizationChecks: [...authorizationChecks, "session-revocation", "durable-reservation"],
        cleanup: { sessions: operation.cleanupConfirmed ? "CONFIRMED" : "UNCONFIRMED",
          processes: independentlyStopped ? "CONFIRMED" : "UNCONFIRMED" },
        facts: { dispatchCount: 1, operationState: operation.status, processCount: observedAfter.length,
          runningProcessCount: observedAfter.filter(item => item.running).length, supervisorCancellationConfirmed: operation.cancellationConfirmed },
      } satisfies Pick<HarnessScenarioRecord, "status" | "observation" | "authorizationChecks" | "cleanup" | "facts">;
      emit("CMD-08", cancelFixture.fixtureId, adapter, values);
      emit("CMD-10", cancelFixture.fixtureId, adapter, values);
    }

    {
      const uncertainFixture = await createPilotFixture();
      begin(["CMD-12"], uncertainFixture.fixtureId);
      const uncertainIdentity = identities.uncertain;
      await register(uncertainFixture, uncertainIdentity);
      const initiating = await capability(uncertainIdentity.project);
      const adapter = adapterFor(uncertainFixture, { fault: "invalid-response" });
      const request = await commandRequest(uncertainFixture, initiating, "npm run lint");
      await denied(() => privateCloudCommandSession(adapter, uncertainIdentity.project, uncertainIdentity.sandbox, request, initiating.authorization), [503]);
      const operation = await database.prisma.commandOperation.findFirstOrThrow({ where: { projectId: uncertainIdentity.project } });
      assert.equal(operation.status, "UNKNOWN");
      const before = adapter.evidence().providerOperations;
      await denied(() => privateCloudCommandSession(adapter, uncertainIdentity.project, uncertainIdentity.sandbox, request, initiating.authorization), [409]);
      assert.equal(adapter.evidence().providerOperations, before);
      assert.equal(await database.prisma.commandOperation.count({ where: { projectId: uncertainIdentity.project } }), 1);
      emit("CMD-12", uncertainFixture.fixtureId, adapter, { status: "PASS", observation: "uncertainty-retained",
        authorizationChecks: [...authorizationChecks, "scoped-approval", "one-time-consumption", "durable-reservation"],
        cleanup: { sessions: operation.cleanupConfirmed ? "CONFIRMED" : "UNCONFIRMED", processes: "UNCONFIRMED" },
        facts: { operationState: "UNKNOWN", rejectedCount: 2 } });
    }
  } finally {
    // Only processes created by the allowlisted local adapter are eligible for
    // fixture disposal. Never alter UNKNOWN database rows or delete workspaces.
    await Promise.allSettled(adapters.map(adapter => adapter.dispose()));
    setPolicyProfile(previousPolicy);
  }
}
