import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import type { GitOperationRequest } from "../../src/lib/security/git-operation-catalogue";
import type { DaytonaProvider } from "../../src/lib/workspace/providers/daytona";
import type { AuthorizationCheck, HarnessWorkflowContext, HarnessScenarioRecord } from "./types";
import { createPilotFixture, createOfflineSandbox } from "./fixtures";
import { createOfflineSessionAdapter } from "./session-adapter";
import { createOfflineGithubAdapter, OFFLINE_GITHUB_CREDENTIAL, type SyntheticGitObject } from "./github-adapter";
import { createOfflineLifecycleAdapter, createOfflineLifecycleTimeoutAdapter, OFFLINE_CLONE_SANDBOX, OFFLINE_TIMEOUT_SANDBOX } from "./lifecycle-adapter";

/** Real PostgreSQL capabilities, approvals and coordinators; actual fixed Python
 * programs and disposable Git objects; controlled SDK/HTTP interfaces only.
 * This function contains no real provider construction or network fallback. */
export async function runGitWorkflow({ database, record, begin }: HarnessWorkflowContext): Promise<void> {
  // Imports follow database initialization so every authorization query uses the
  // isolated schema. AuthSession provenance comes from the real cookie resolver.
  const lifecycle = await import("../../src/lib/workspace/private-workspace-lifecycle");
  const execution = await import("../../src/lib/security/execution-context");
  const approvals = await import("../../src/lib/security/git-approvals");
  const catalogue = await import("../../src/lib/security/git-operation-catalogue");
  const grants = await import("../../src/lib/security/git-authorization");
  const coordinator = await import("../../src/lib/workspace/private-git-operations");
  const { privateCloudWriteSession } = await import("../../src/lib/workspace/private-cloud-write-session");
  const { createPrivateRepositoryInitializationTransport } = await import("../../src/lib/workspace/private-repository-initialization");
  const fixture = await createPilotFixture();
  const sandboxRoot = await createOfflineSandbox();
  const destination = path.join(sandboxRoot, "repo");
  const local = createOfflineSessionAdapter(sandboxRoot);
  const controlled = createOfflineLifecycleAdapter(local);
  const timedOut = createOfflineLifecycleTimeoutAdapter();
  const github = createOfflineGithubAdapter({ repositoryKey: fixture.repositoryKey, branch: fixture.branch,
    head: fixture.head, objects: [...fixture.graph.objects] });
  // The application only calls the fixed session-process subset. This offline
  // structural adapter never constructs the SDK's full Process client.
  const source = createPrivateRepositoryInitializationTransport(controlled.sessionProvider as unknown as Pick<DaytonaProvider, "getPrivateGitSessionProcess">,
    () => OFFLINE_GITHUB_CREDENTIAL, github.fetcher);
  const identity = await database.createSession();
  const cleanup = { sessions: "CONFIRMED", processes: "CONFIRMED" } as const;
  const checks = ["owner-session", "registered-project", "workspace-binding", "repository-binding",
    "scoped-approval", "one-time-consumption", "durable-reservation"] as const;
  const total = () => github.evidence().operations + controlled.evidence().operations + timedOut.evidence().operations + local.evidence().providerOperations;
  const report = (testId: string, observation: HarnessScenarioRecord["observation"], facts?: HarnessScenarioRecord["facts"]) => {
    assert.equal(local.evidence().helpersStillRunning, 0);
    assert.equal(local.evidence().openSessions, 0);
    const authorizationChecks: readonly AuthorizationCheck[] = testId === "INIT-11" ? ["owner-session", "repository-binding"]
      : testId === "LIFE-02" ? ["owner-session", "registered-project", "workspace-binding"]
      : testId === "LIFE-08" ? ["owner-session", "scoped-approval", "one-time-consumption", "durable-reservation"]
      : testId === "GIT-13" ? [...checks, "agent-permission", "session-revocation"]
      : testId.startsWith("GIT-") ? [...checks, "agent-permission"] : checks;
    record({ testId, fixtureId: fixture.fixtureId, status: "PASS", observation,
      providerOperations: total(), authorizationChecks, cleanup, ...(facts ? { facts } : {}),
    });
  };
  try {
    const clone = { action: "clone", idempotencyKey: randomUUID(), repositoryUrl: `https://github.com/${fixture.repositoryKey}.git`,
      branch: fixture.branch, projectName: "Synthetic provider pilot" };

    // An untrusted response cannot select another repository or create anything.
    begin(["INIT-11"], fixture.fixtureId);
    github.setFault("wrong-repository");
    await assert.rejects(lifecycle.prepareWorkspaceLifecycleWithRepository(identity.session, clone, source));
    assert.equal(controlled.evidence().creates, 0);
    assert.equal(github.evidence().mutations, 0);
    report("INIT-11", "rejected", { rejectedCount: 1, dispatchCount: 0 });
    github.setFault("none");

    begin(["INIT-01", "INIT-02", "INIT-03", "LIFE-01"], fixture.fixtureId);
    const approval = await lifecycle.prepareWorkspaceLifecycleWithRepository(identity.session, clone, source);
    await lifecycle.decideWorkspaceLifecycle(identity.session, approval.approvalId, "approve");
    const initialized = await lifecycle.executeWorkspaceLifecycleWithProvider(identity.session, clone,
      controlled.provider, approval.approvalId, undefined, source);
    assert.equal(initialized.status, "SUCCEEDED");
    const registration = await database.prisma.workspace.findUniqueOrThrow({ where: { id: approval.scope.workspaceRecordId } });
    assert.equal(registration.projectId, initialized.projectId);
    assert.equal(registration.providerWorkspaceId, OFFLINE_CLONE_SANDBOX);
    assert.equal(registration.state, "ready");
    assert.equal(registration.branch, fixture.branch);
    assert.equal(registration.repositoryUrl, `https://github.com/${fixture.repositoryKey}.git`);
    assert.equal(await fs.readFile(path.join(destination, ".git/HEAD"), "utf8"), `ref: refs/heads/${fixture.branch}\n`);
    assert.equal((await fs.readFile(path.join(destination, ".git/refs/heads", fixture.branch), "utf8")).trim(), fixture.head);
    for (const object of fixture.graph.objects) {
      const actual = inflateSync(await fs.readFile(path.join(destination, ".git/objects", object.oid.slice(0, 2), object.oid.slice(2))));
      const content = Buffer.from(object.contentBase64, "base64");
      assert.deepEqual(actual, Buffer.concat([Buffer.from(`${object.type} ${content.length}\0`), content]));
    }
    for (const file of fixture.files) {
      const actual = await fs.readFile(path.join(destination, file.path));
      assert.equal(actual.length, file.bytes);
      assert.equal(createHash("sha256").update(actual).digest("hex"), file.sha256);
    }
    assert.equal((await fs.readFile(path.join(destination, ".git/config"), "utf8")).includes(OFFLINE_GITHUB_CREDENTIAL), false);
    report("INIT-01", "verified", { head: fixture.head, objectCount: fixture.graph.objects.length, operationState: "SUCCEEDED" });
    report("INIT-02", "verified", { head: fixture.head, objectCount: fixture.graph.objects.length });
    report("INIT-03", "verified", { head: fixture.head });
    report("LIFE-01", "verified", { dispatchCount: 1, operationState: "SUCCEEDED" });

    begin(["INIT-18", "LIFE-02"], fixture.fixtureId);
    const repeated = await lifecycle.executeWorkspaceLifecycleWithProvider(identity.session, clone,
      controlled.provider, approval.approvalId, undefined, source);
    assert.equal(repeated.operationId, initialized.operationId);
    assert.equal(controlled.evidence().creates, 1);
    const status = await lifecycle.inspectWorkspaceLifecycleWithProvider(identity.session, initialized.projectId, controlled.provider);
    assert.equal(status.state, "started");
    assert.equal(status.workspaceId, registration.id);
    assert.equal(controlled.evidence().creates, 1);
    report("INIT-18", "verified", { dispatchCount: 1, operationState: "SUCCEEDED" });
    report("LIFE-02", "verified", { dispatchCount: 1 });

    const context = await execution.createExecutionAuthorization(identity.session, initialized.projectId);
    assert.ok(context);
    const localAdapter = coordinator.createDaytonaGitAdapter(controlled.sessionProvider as DaytonaProvider);
    const pushAdapter = coordinator.createGithubObjectTransferAdapter(controlled.sessionProvider as DaytonaProvider,
      () => OFFLINE_GITHUB_CREDENTIAL, github.fetcher);
    const approvedGrant = async (request: GitOperationRequest) => {
      const scope = catalogue.buildGitOperationScope(context, request);
      const approved = await approvals.createPrivateGitApproval(context, scope);
      await approvals.decidePrivateGitApproval(identity.session, approved.id, "approved");
      const tool = { actorId: "frontend", actorRole: "agent", projectId: initialized.projectId,
        authorization: context, workspaceRoot: destination, requestId: randomUUID(), approvalId: approved.id };
      // A server-selected reviewer cannot gain a write tier by claiming owner.
      await assert.rejects(grants.authorizeAgentGitOperation(context, request,
        { ...tool, actorId: "security", actorRole: "owner" }));
      const grant = await grants.authorizeAgentGitOperation(context, request, tool);
      // Consumption is one-time even without a provider dispatch.
      await assert.rejects(grants.authorizeOwnerGitOperation(context, request, identity.session, approved.id));
      return grant;
    };
    const localState = async () => {
      const request = { operation: "status", branch: fixture.branch } as const;
      const grant = await grants.authorizeOwnerGitOperation(context, request, identity.session);
      const result = await coordinator.executeAuthorizedGitOperation(grant, context, request, localAdapter);
      assert.equal(result.status, "SUCCEEDED");
      return result.data as { head: string; index: string; branch: string };
    };
    const cycle = async (number: 1 | 2) => {
      await privateCloudWriteSession(local, initialized.projectId, OFFLINE_CLONE_SANDBOX, "source.txt",
        `Synthetic application edit cycle ${number}: café 🌍\n`, context);
      const state = await localState();
      const stage = { operation: "stage", branch: fixture.branch, expectedHead: state.head, expectedIndex: state.index,
        paths: ["source.txt"] } as const;
      const stageRequest = catalogue.parseGitOperation(stage);
      const staged = await coordinator.executeAuthorizedGitOperation(await approvedGrant(stageRequest), context, stageRequest, localAdapter);
      assert.equal(staged.status, "SUCCEEDED");
      const stagedState = staged.data as { head: string; index: string };
      const commit: GitOperationRequest = { operation: "commit", branch: fixture.branch, expectedHead: stagedState.head,
        expectedIndex: stagedState.index, category: "General maintenance" };
      const committed = await coordinator.executeAuthorizedGitOperation(await approvedGrant(commit), context, commit, localAdapter);
      assert.equal(committed.status, "SUCCEEDED");
      const data = committed.data as { head: string; title: string };
      assert.equal(data.title, `VFY-00${number}: General maintenance`);
      assert.notEqual(data.head, state.head);
      return data.head;
    };

    begin(["GIT-02"], fixture.fixtureId);
    const firstHead = await cycle(1);
    begin(["GIT-03", "GIT-05"], fixture.fixtureId);
    const firstPush: GitOperationRequest = { operation: "push", branch: fixture.branch, expectedRemoteHead: fixture.head, targetCommit: firstHead };
    const firstScope = catalogue.buildGitOperationScope(context, firstPush);
    const pushApproval = await approvals.createPrivateGitApproval(context, firstScope);
    await approvals.decidePrivateGitApproval(identity.session, pushApproval.id, "approved");
    // Scope changes do not consume the intended approval or reach transport.
    const beforeMismatch = total();
    await assert.rejects(grants.authorizeOwnerGitOperation(context,
      { ...firstPush, targetCommit: "1".repeat(40) }, identity.session, pushApproval.id));
    assert.equal(total(), beforeMismatch);
    const firstGrant = await grants.authorizeOwnerGitOperation(context, firstPush, identity.session, pushApproval.id);
    const pushed = await coordinator.executeAuthorizedGitOperation(firstGrant, context, firstPush, pushAdapter);
    assert.equal(pushed.status, "SUCCEEDED");
    assert.equal(github.head, firstHead);
    assert.equal(github.evidence().branchUpdates, 1);
    // Independently compare every uploaded loose object, including blobs and
    // trees, to actual on-disk bytes, not just a provider success receipt.
    let uploadedCount = 0;
    for (const prefix of await fs.readdir(path.join(destination, ".git/objects"))) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const suffix of await fs.readdir(path.join(destination, ".git/objects", prefix))) {
        if (!/^[0-9a-f]{38}$/.test(suffix)) continue;
        const raw = inflateSync(await fs.readFile(path.join(destination, ".git/objects", prefix, suffix)));
        const zero = raw.indexOf(0);
        const type = raw.subarray(0, zero).toString().split(" ")[0] as SyntheticGitObject["type"];
        const object = { oid: prefix + suffix, type, contentBase64: raw.subarray(zero + 1).toString("base64") };
        assert.equal(createHash("sha1").update(raw).digest("hex"), object.oid);
        assert.equal(github.hasExactObject(object), true);
        uploadedCount++;
      }
    }
    report("GIT-03", "verified", { head: firstHead, objectCount: uploadedCount });
    report("GIT-05", "verified", { head: firstHead, dispatchCount: 1, operationState: "SUCCEEDED" });

    const secondHead = await cycle(2);
    report("GIT-02", "verified", { head: secondHead, dispatchCount: 4 });
    const secondPush: GitOperationRequest = { operation: "push", branch: fixture.branch, expectedRemoteHead: firstHead, targetCommit: secondHead };
    begin(["GIT-11", "GIT-13"], fixture.fixtureId);
    const secondGrant = await approvedGrant(secondPush);
    github.setFault("lost-branch-acknowledgment");
    const uncertain = await coordinator.executeAuthorizedGitOperation(secondGrant, context, secondPush, pushAdapter);
    assert.equal(uncertain.status, "UNKNOWN");
    assert.equal(github.head, secondHead); // Effect occurred, response was lost.
    assert.equal(github.evidence().branchUpdates, 2);
    const rows = await database.prisma.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "GitOperation" WHERE "id" = ${uncertain.operationId}::uuid`;
    assert.equal(rows[0]?.status, "UNKNOWN");
    report("GIT-11", "uncertainty-retained", { head: secondHead, operationState: "UNKNOWN", dispatchCount: 1 });
    const beforeDuplicate = total();
    await assert.rejects(coordinator.executeAuthorizedGitOperation(secondGrant, context, secondPush, pushAdapter));
    assert.equal(total(), beforeDuplicate);
    assert.equal((await database.prisma.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "GitOperation" WHERE "id" = ${uncertain.operationId}::uuid`)[0]?.status, "UNKNOWN");
    await database.prisma.authSession.update({ where: { id: identity.sessionId }, data: { revokedAt: new Date() } });
    await assert.rejects(localState());
    assert.equal(total(), beforeDuplicate);
    report("GIT-13", "rejected", { rejectedCount: 2, dispatchCount: 0, operationState: "UNKNOWN" });

    // A separately bound synthetic creation timeout is retained in PostgreSQL.
    // The fault represents a lost response, not measured live timeout behavior.
    begin(["LIFE-08"], fixture.fixtureId);
    const timeoutIdentity = await database.createSession();
    const create = { action: "create", idempotencyKey: randomUUID(), projectName: "Synthetic timeout fixture" };
    const timeoutApproval = await lifecycle.prepareWorkspaceLifecycle(timeoutIdentity.session, create);
    await lifecycle.decideWorkspaceLifecycle(timeoutIdentity.session, timeoutApproval.approvalId, "approve");
    await assert.rejects(lifecycle.executeWorkspaceLifecycleWithProvider(timeoutIdentity.session, create,
      timedOut.provider, timeoutApproval.approvalId));
    const timeoutRows = await database.prisma.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status" FROM "WorkspaceLifecycleOperation" WHERE "idempotencyKey" = ${create.idempotencyKey}::uuid`;
    assert.equal(timeoutRows.length, 1);
    assert.equal(timeoutRows[0].status, "UNKNOWN");
    assert.equal(await database.prisma.project.findUnique({ where: { id: timeoutApproval.scope.projectId } }), null);
    assert.equal(await database.prisma.workspace.findUnique({ where: { id: timeoutApproval.scope.workspaceRecordId } }), null);
    const observed = await timedOut.provider.inspect(OFFLINE_TIMEOUT_SANDBOX, new AbortController().signal);
    assert.equal(observed.labels["cr8or-operation"], timeoutRows[0].id);
    assert.equal(observed.labels["cr8or-project"], timeoutApproval.scope.projectId);
    const uncertainReplay = await lifecycle.executeWorkspaceLifecycleWithProvider(timeoutIdentity.session, create,
      timedOut.provider, timeoutApproval.approvalId);
    assert.equal(uncertainReplay.status, "UNKNOWN");
    assert.equal(uncertainReplay.operationId, timeoutRows[0].id);
    assert.equal(timedOut.evidence().creates, 1);
    report("LIFE-08", "uncertainty-retained", { dispatchCount: 1, operationState: "UNKNOWN" });
  } finally {
    // Stop only processes/sessions born in this local fixture. The synthetic
    // repository and PostgreSQL UNKNOWN evidence remain for operator review.
    await local.dispose();
  }
}
