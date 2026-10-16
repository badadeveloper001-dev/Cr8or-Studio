import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ check: vi.fn(), runtime: vi.fn(), run: vi.fn(), audit: vi.fn(),
  consumeApproval: vi.fn(), validateApproval: vi.fn() }));
vi.mock("@/lib/security/execution-context", () => ({
  ExecutionAuthorizationError: class extends Error { constructor(readonly status: number, message = "Authentication required.") { super(message); } },
  revalidateExecutionAuthorization: mocks.check,
}));
vi.mock("@/lib/workspace/runtime-factory", () => ({ getWorkspaceRuntime: mocks.runtime }));
vi.mock("@/lib/security/audit", () => ({ appendAuditEvent: mocks.audit }));
vi.mock("@/lib/security/command-approvals", () => ({
  consumePrivateCommandApproval: mocks.consumeApproval,
  validateConsumedPrivateCommandApproval: mocks.validateApproval,
}));

import { authorizeDevelopmentCommand, validateCommandAuthorization, type CommandAuthorization } from "@/lib/security/command-authorization";
import { DEVELOPMENT_COMMAND_TIMEOUT_MS, findDevelopmentCommand } from "@/lib/security/command-catalogue";
import { ExecutionAuthorizationError, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { decideApproval, listApprovals, requestApproval } from "@/lib/security/approvals";
import { setPolicyProfile } from "@/lib/security/policy";
import { executeTool } from "@/lib/agents/tool-executor";
import { toolMetadata, type ToolContext } from "@/lib/agents/tools";

let execution: ExecutionAuthorizationContext;
let active: boolean;
const context = (actorId = "frontend"): ToolContext => ({ projectId: "registered", workspaceRoot: "/not-authority",
  actorId, actorRole: "agent", requestId: "request", authorization: execution });
const request = (grant?: CommandAuthorization, command = "npm test") => ({ command, commandKey: command,
  rules: findDevelopmentCommand(command)!.rules, timeoutMs: DEVELOPMENT_COMMAND_TIMEOUT_MS, commandAuthorization: grant });

beforeEach(() => {
  vi.resetAllMocks();
  active = true;
  setPolicyProfile("autonomous");
  // Isolate grant provenance and sequencing here; integration tests use real
  // PostgreSQL capabilities, session revocation and credential rotation.
  execution = Object.freeze({ projectId: "registered", executionId: "execution", signal: new AbortController().signal,
    workspace: { runtimeType: "cloud", provider: "daytona", providerWorkspaceId: "registered-sandbox" } }) as unknown as ExecutionAuthorizationContext;
  mocks.check.mockImplementation(async (candidate, projectId) => {
    if (!active || candidate !== execution || projectId !== "registered") throw new ExecutionAuthorizationError(401);
  });
  mocks.runtime.mockResolvedValue({ runCommand: mocks.run });
  mocks.run.mockResolvedValue({ stdout: "finished", stderr: "", exitCode: 0 });
  // Only explicit successful durable-store results may establish approval.
  mocks.consumeApproval.mockResolvedValue(false);
  mocks.validateApproval.mockResolvedValue(false);
});

async function mint() {
  const result = await authorizeDevelopmentCommand(context(), "npm test");
  if (!result.allowed) throw new Error("Expected grant");
  return result.authorization;
}

describe("trusted command authorization grants", () => {
  it("binds a fresh opaque operation to the exact context, agent and catalogue entry", async () => {
    const grant = await mint();
    const metadata = await validateCommandAuthorization(grant, execution, request(grant));
    expect(metadata).toMatchObject({ actorId: "frontend", executionId: "execution", requestId: "request", commandKey: "npm test" });
    expect(metadata.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(grant)).toBe("{}");
    expect(Object.isFrozen(grant)).toBe(true);
    expect((await validateCommandAuthorization(grant, execution, request(grant))).operationId).toBe(metadata.operationId);
  });

  it("rejects missing authorization even while private authentication is inactive", async () => {
    await expect(authorizeDevelopmentCommand({ ...context(), authorization: undefined }, "npm test")).rejects.toMatchObject({ status: 401 });
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it.each(["security", "qa", "devops", "architect", "owner", "unknown"])("does not elevate %s through an owner role claim", async (actorId) => {
    await expect(authorizeDevelopmentCommand({ ...context(actorId), actorRole: "owner" }, "npm test")).rejects.toMatchObject({ status: 403 });
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("rejects fabricated grants, copied grants and another context", async () => {
    const grant = await mint();
    for (const fake of [undefined, {} as CommandAuthorization, { ...grant } as CommandAuthorization]) {
      await expect(validateCommandAuthorization(fake, execution, request(fake))).rejects.toMatchObject({ status: 403 });
    }
    await expect(validateCommandAuthorization(grant, { ...execution } as ExecutionAuthorizationContext, request(grant))).rejects.toMatchObject({ status: 403 });
    await expect(validateCommandAuthorization(grant, execution, request(grant, "npm run lint"))).rejects.toMatchObject({ status: 403 });
  });

  it("revalidates the initiating session on every grant validation", async () => {
    const grant = await mint();
    await validateCommandAuthorization(grant, execution, request(grant));
    active = false;
    await expect(validateCommandAuthorization(grant, execution, request(grant))).rejects.toMatchObject({ status: 401 });
  });

  it("invalidates an existing grant when the command policy profile changes", async () => {
    const grant = await mint();
    setPolicyProfile("strict");
    await expect(validateCommandAuthorization(grant, execution, request(grant))).rejects.toMatchObject({ status: 409 });
  });

  it.each(["balanced", "strict"] as const)("requires a durable scoped approval under %s policy", async (profile) => {
    setPolicyProfile(profile);
    expect(await authorizeDevelopmentCommand(context(), "npm test")).toMatchObject({ allowed: false, requiresApproval: true });
    expect(await authorizeDevelopmentCommand({ ...context(), approvalId: "fabricated-approved-id" }, "npm test")).toMatchObject({ allowed: false });
    expect(mocks.consumeApproval).toHaveBeenCalledTimes(1);
    expect(mocks.validateApproval).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it.each(["balanced", "strict"] as const)("does not reinterpret an approved action-only command approval under %s policy", async (profile) => {
    setPolicyProfile(profile);
    const approval = requestApproval({ action: "commands.execute", title: "Run tests", preview: "npm test", requestedBy: "owner", requestedRole: "owner" });
    decideApproval({ id: approval.id, decision: "approved", decidedBy: "owner", decidedRole: "owner" });
    expect(await authorizeDevelopmentCommand({ ...context(), approvalId: approval.id }, "npm test"))
      .toMatchObject({ allowed: false, requiresApproval: true });
    expect(mocks.consumeApproval).toHaveBeenCalledWith(execution, "npm test", approval.id, expect.any(String), "frontend");
    expect(listApprovals().find((record) => record.id === approval.id)?.consumedAt).toBeUndefined();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it.each(["balanced", "strict"] as const)("binds one consumed scope to the exact operation and rechecks its receipt under %s policy", async (profile) => {
    setPolicyProfile(profile);
    mocks.consumeApproval.mockResolvedValueOnce(true);
    mocks.validateApproval.mockResolvedValue(true);
    const approvedContext = { ...context(), approvalId: "durable-approved-id" };
    const result = await authorizeDevelopmentCommand(approvedContext, "npm test");
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error("Expected scoped grant");
    const metadata = await validateCommandAuthorization(result.authorization, execution, request(result.authorization));
    const expected = [execution, "npm test", approvedContext.approvalId, metadata.operationId, "frontend"];
    expect(mocks.consumeApproval).toHaveBeenCalledWith(...expected);
    expect(mocks.validateApproval).toHaveBeenCalledWith(...expected);
    expect(metadata.operationId).toMatch(/^[0-9a-f-]{36}$/);
    await validateCommandAuthorization(result.authorization, execution, request(result.authorization));
    expect(mocks.consumeApproval).toHaveBeenCalledTimes(1);
    expect(mocks.validateApproval).toHaveBeenCalledTimes(2);
    expect(await authorizeDevelopmentCommand(approvedContext, "npm test")).toMatchObject({ allowed: false });
    expect(mocks.consumeApproval.mock.calls[1][3]).not.toBe(metadata.operationId);
  });

  it("rejects an invalidated consumed approval instead of releasing its grant", async () => {
    setPolicyProfile("balanced");
    mocks.consumeApproval.mockResolvedValueOnce(true);
    mocks.validateApproval.mockResolvedValueOnce(true);
    const result = await authorizeDevelopmentCommand({ ...context(), approvalId: "durable-approved-id" }, "npm test");
    if (!result.allowed) throw new Error("Expected scoped grant");
    await validateCommandAuthorization(result.authorization, execution, request(result.authorization));
    await expect(validateCommandAuthorization(result.authorization, execution, request(result.authorization)))
      .rejects.toMatchObject({ status: 403 });
  });

  it("denies approval-store failures without falling back to a legacy approval", async () => {
    setPolicyProfile("balanced");
    const approval = requestApproval({ action: "commands.execute", title: "Run tests", preview: "npm test", requestedBy: "owner", requestedRole: "owner" });
    decideApproval({ id: approval.id, decision: "approved", decidedBy: "owner", decidedRole: "owner" });
    mocks.consumeApproval.mockRejectedValue(new ExecutionAuthorizationError(503, "Approval infrastructure unavailable."));
    await expect(authorizeDevelopmentCommand({ ...context(), approvalId: approval.id }, "npm test"))
      .rejects.toMatchObject({ status: 503 });
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("fails closed when consumed approval validation loses database access", async () => {
    setPolicyProfile("strict");
    mocks.consumeApproval.mockResolvedValueOnce(true);
    mocks.validateApproval.mockRejectedValue(new ExecutionAuthorizationError(503, "Approval infrastructure unavailable."));
    const result = await authorizeDevelopmentCommand({ ...context(), approvalId: "durable-approved-id" }, "npm test");
    if (!result.allowed) throw new Error("Expected scoped grant");
    await expect(validateCommandAuthorization(result.authorization, execution, request(result.authorization)))
      .rejects.toMatchObject({ status: 503 });
  });

  it("checks the session before consuming approval and again after consumption", async () => {
    setPolicyProfile("balanced");
    const approvedContext = { ...context(), approvalId: "durable-approved-id" };
    active = false;
    await expect(authorizeDevelopmentCommand(approvedContext, "npm test")).rejects.toMatchObject({ status: 401 });
    expect(mocks.consumeApproval).not.toHaveBeenCalled();
    active = true;
    mocks.consumeApproval.mockImplementationOnce(async () => { active = false; return true; });
    await expect(authorizeDevelopmentCommand(approvedContext, "npm test")).rejects.toMatchObject({ status: 401 });
    expect(mocks.consumeApproval).toHaveBeenCalledTimes(1);
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("checks session validity before consulting an existing receipt", async () => {
    setPolicyProfile("balanced");
    mocks.consumeApproval.mockResolvedValueOnce(true);
    mocks.validateApproval.mockResolvedValue(true);
    const result = await authorizeDevelopmentCommand({ ...context(), approvalId: "durable-approved-id" }, "npm test");
    if (!result.allowed) throw new Error("Expected scoped grant");
    active = false;
    await expect(validateCommandAuthorization(result.authorization, execution, request(result.authorization)))
      .rejects.toMatchObject({ status: 401 });
    expect(mocks.validateApproval).not.toHaveBeenCalled();
  });

  it("does not use a valid consumed receipt after a policy-profile change", async () => {
    setPolicyProfile("balanced");
    mocks.consumeApproval.mockResolvedValueOnce(true);
    mocks.validateApproval.mockResolvedValue(true);
    const result = await authorizeDevelopmentCommand({ ...context(), approvalId: "durable-approved-id" }, "npm test");
    if (!result.allowed) throw new Error("Expected scoped grant");
    setPolicyProfile("autonomous");
    await expect(validateCommandAuthorization(result.authorization, execution, request(result.authorization)))
      .rejects.toMatchObject({ status: 409 });
  });

  it("does not mint a grant when policy changes during approval consumption", async () => {
    setPolicyProfile("balanced");
    mocks.consumeApproval.mockImplementationOnce(async () => { setPolicyProfile("autonomous"); return true; });
    await expect(authorizeDevelopmentCommand({ ...context(), approvalId: "durable-approved-id" }, "npm test"))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("requires a valid session in autonomous mode without consuming human approval", async () => {
    const grant = await mint();
    await validateCommandAuthorization(grant, execution, request(grant));
    expect(mocks.consumeApproval).not.toHaveBeenCalled();
    expect(mocks.validateApproval).not.toHaveBeenCalled();
    active = false;
    await expect(validateCommandAuthorization(grant, execution, request(grant))).rejects.toMatchObject({ status: 401 });
    await expect(authorizeDevelopmentCommand(context(), "npm test")).rejects.toMatchObject({ status: 401 });
  });

  it("does not accept a file-write approval in place of command approval", async () => {
    setPolicyProfile("balanced");
    const approval = requestApproval({ action: "files.write", title: "Write", preview: "Write", requestedBy: "owner", requestedRole: "owner" });
    decideApproval({ id: approval.id, decision: "approved", decidedBy: "owner", decidedRole: "owner" });
    expect(await authorizeDevelopmentCommand({ ...context(), approvalId: approval.id }, "npm test")).toMatchObject({ allowed: false });
  });
});

describe("agent command integration", () => {
  it("classifies npm scripts as mutating high-risk project code", () => {
    expect(toolMetadata.run_command).toMatchObject({ mutating: true, risk: "high", policyAction: "commands.execute" });
  });

  it("passes an opaque grant and reports nonzero exit as failure", async () => {
    mocks.run.mockResolvedValue({ stdout: "test report", stderr: "failed", exitCode: 1 });
    const result = await executeTool("run_command", { command: "npm test" }, context());
    expect(result).toMatchObject({ ok: false, workspaceChanged: true, data: { exitCode: 1 } });
    const supplied = mocks.run.mock.calls[0][0];
    expect(await validateCommandAuthorization(supplied.commandAuthorization, execution, supplied)).toMatchObject({ actorId: "frontend" });
    expect(supplied.timeoutMs).toBe(60_000);
  });

  it("does not expose rejected command contents or provider errors in audit or results", async () => {
    const rejected = "npm test; PRIVATE_CONTENT";
    const invalid = await executeTool("run_command", { command: rejected }, context());
    expect(invalid.ok).toBe(false);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("PRIVATE_CONTENT");
    expect(mocks.runtime).not.toHaveBeenCalled();
    mocks.run.mockRejectedValue(new Error("provider key=PRIVATE_PROVIDER_SECRET"));
    const failure = await executeTool("run_command", { command: "npm test" }, context());
    expect(failure).toMatchObject({ ok: false, error: "Command execution failed." });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("PRIVATE_PROVIDER_SECRET");
  });

  it("does not release output after the session becomes invalid", async () => {
    mocks.run.mockImplementation(async () => { active = false; return { stdout: "sensitive output", stderr: "", exitCode: 0 }; });
    await expect(executeTool("run_command", { command: "npm test" }, context())).rejects.toMatchObject({ status: 401 });
  });
});
