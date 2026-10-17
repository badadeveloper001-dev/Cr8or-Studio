import "server-only";

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { getToolPresetForActor, type ToolContext } from "@/lib/agents/tools";
import { resolvePrivateOwnerBinding, type AuthSession } from "@/lib/security/auth";
import { appendAuditEvent } from "@/lib/security/audit";
import { ExecutionAuthorizationError, revalidateExecutionAuthorization, resolveExecutionSessionBinding, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { buildGitOperationScope, canonicalGitRepository, gitScopeDigest, isGitMutation, parseGitOperation, type GitOperationRequest, type GitOperationScope } from "@/lib/security/git-operation-catalogue";
import { consumePrivateGitApproval, validateConsumedPrivateGitApproval } from "@/lib/security/git-approvals";
import { getPolicyProfile, type PolicyProfile } from "@/lib/security/policy";

const MINT_GIT = Symbol("mint-git");
type Actor = { id: string; agent: boolean };
export type GitAuthorizationMetadata = Readonly<{ operationId: string; executionId: string; actorId: string; scope: GitOperationScope }>;

/** Every boundary resolves the session and repository again. A URL alone does
 * not establish owner authorization or permit arbitrary GitHub access. */
export async function validateGitRepositoryContext(context: ExecutionAuthorizationContext, input: GitOperationRequest): Promise<GitOperationScope> {
  const request = parseGitOperation(input);
  const permission = isGitMutation(request.operation) ? "write" : "read";
  // Unlike inactive legacy helpers, this private service always requires proof.
  await resolveExecutionSessionBinding(context, permission);
  try {
    const scope = buildGitOperationScope(context, request);
    const project = await prisma.project.findUnique({ where: { id: context.projectId }, select: { repository: true } });
    if (!project?.repository || canonicalGitRepository(project.repository).key !== scope.repositoryKey) {
      throw new ExecutionAuthorizationError(409, "Registered repository bindings do not match.");
    }
    await revalidateExecutionAuthorization(context, context.projectId, permission);
    return scope;
  } catch (error) {
    if (error instanceof ExecutionAuthorizationError) throw error;
    throw new ExecutionAuthorizationError(503, "Git authorization is unavailable.");
  }
}
function checkAgent(actor: Actor, request: GitOperationRequest): void {
  if (!actor.agent) return;
  const tools = getToolPresetForActor(actor.id);
  if (!tools.includes(isGitMutation(request.operation) ? "run_command" : request.operation === "diff" ? "git_diff" : "git_status")) {
    throw new ExecutionAuthorizationError(403, "Agent cannot perform this Git operation.");
  }
}
class GitCapability {
  #context: ExecutionAuthorizationContext;
  #profile: PolicyProfile;
  #approvalId?: string;
  #actor: Actor;
  #metadata: GitAuthorizationMetadata;
  constructor(key: symbol, context: ExecutionAuthorizationContext, scope: GitOperationScope, actor: Actor, profile: PolicyProfile, operationId: string, approvalId?: string) {
    if (key !== MINT_GIT) throw new ExecutionAuthorizationError(403);
    this.#context = context; this.#profile = profile; this.#approvalId = approvalId; this.#actor = Object.freeze(actor);
    this.#metadata = Object.freeze({ operationId, executionId: context.executionId, actorId: actor.id, scope });
    Object.freeze(this);
  }
  static async validate(grant: GitAuthorization, context: ExecutionAuthorizationContext, request: GitOperationRequest): Promise<GitAuthorizationMetadata> {
    if (!grant || typeof grant !== "object" || !(#context in grant) || grant.#context !== context) throw new ExecutionAuthorizationError(403);
    checkAgent(grant.#actor, request);
    const scope = await validateGitRepositoryContext(context, request);
    if (gitScopeDigest(scope) !== gitScopeDigest(grant.#metadata.scope) || getPolicyProfile() !== grant.#profile) throw new ExecutionAuthorizationError(409);
    if (grant.#approvalId && !await validateConsumedPrivateGitApproval(context, scope, grant.#approvalId, grant.#metadata.operationId, grant.#actor.id)) {
      throw new ExecutionAuthorizationError(403, "Git approval is no longer valid.");
    }
    if (getPolicyProfile() !== grant.#profile) throw new ExecutionAuthorizationError(409);
    return grant.#metadata;
  }
}
export type GitAuthorization = GitCapability;
async function mint(context: ExecutionAuthorizationContext, input: GitOperationRequest, actor: Actor, approvalId?: string): Promise<GitAuthorization> {
  const request = parseGitOperation(input);
  checkAgent(actor, request);
  const scope = await validateGitRepositoryContext(context, request);
  const profile = getPolicyProfile(), operationId = randomUUID();
  const required = isGitMutation(request.operation) && profile !== "autonomous";
  const receipt = required ? approvalId : undefined;
  const allowed = !required || (!!receipt && await consumePrivateGitApproval(context, scope, receipt, operationId, actor.id));
  appendAuditEvent({ id: randomUUID(), at: new Date().toISOString(), actorId: actor.id, actorRole: actor.agent ? "agent" : "owner",
    action: "policy.check", outcome: allowed ? "allow" : "deny", reason: "scoped Git operation policy",
    metadata: { operationId, projectId: scope.projectId, operation: scope.operationKey, profile, approvalRequired: required } });
  if (!allowed) throw new ExecutionAuthorizationError(409, "Approval for this exact Git operation is required.");
  await validateGitRepositoryContext(context, request);
  if (getPolicyProfile() !== profile) throw new ExecutionAuthorizationError(409);
  return new GitCapability(MINT_GIT, context, scope, actor, profile, operationId, receipt);
}

/** Owner dispatch requires an actual private AuthSession, never a role claim. */
export async function authorizeOwnerGitOperation(context: ExecutionAuthorizationContext, request: GitOperationRequest, session: AuthSession, approvalId?: string): Promise<GitAuthorization> {
  const permission = isGitMutation(request.operation) ? "write" : "read";
  const contextBinding = await resolveExecutionSessionBinding(context, permission);
  const ownerBinding = await resolvePrivateOwnerBinding(session);
  if (!ownerBinding || ownerBinding.sessionId !== contextBinding.sessionId || ownerBinding.credentialVersion !== contextBinding.credentialVersion) throw new ExecutionAuthorizationError(401);
  return mint(context, request, { id: "owner", agent: false }, approvalId);
}
/** ToolContext is supplied by the server pipeline; actorRole is never authority. */
export async function authorizeAgentGitOperation(context: ExecutionAuthorizationContext, request: GitOperationRequest, tool: ToolContext): Promise<GitAuthorization> {
  if (!context || !tool || tool.authorization !== context || tool.projectId !== context.projectId) throw new ExecutionAuthorizationError(403);
  return mint(context, request, { id: tool.actorId, agent: true }, tool.approvalId);
}
/** Direct runtime reads inherit the validated owner capability but never gain
 * mutation authority. Agent callers additionally enforce their own fixed tier. */
export async function authorizeRuntimeGitRead(context: ExecutionAuthorizationContext, request: GitOperationRequest): Promise<GitAuthorization> {
  if (isGitMutation(request.operation)) throw new ExecutionAuthorizationError(403);
  return mint(context, request, { id: "runtime", agent: false });
}
export async function validateGitAuthorization(grant: GitAuthorization, context: ExecutionAuthorizationContext, request: GitOperationRequest): Promise<GitAuthorizationMetadata> {
  return GitCapability.validate(grant, context, parseGitOperation(request));
}
