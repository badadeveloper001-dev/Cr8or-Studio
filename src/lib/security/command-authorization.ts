import "server-only";

import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@/lib/security/audit";
import { consumePrivateCommandApproval, validateConsumedPrivateCommandApproval } from "@/lib/security/command-approvals";
import { getToolPresetForActor, type ToolContext } from "@/lib/agents/tools";
import { findDevelopmentCommand, validateCommandRequest } from "@/lib/security/command-catalogue";
import { ExecutionAuthorizationError, revalidateExecutionAuthorization, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { getPolicyProfile, type PolicyProfile } from "@/lib/security/policy";
import type { ValidatedCommandRequest } from "@/lib/workspace/runtime";

const MINT_COMMAND = Symbol("mint-command");

export type CommandAuthorizationMetadata = Readonly<{
  operationId: string;
  actorId: string;
  executionId: string;
  commandKey: string;
  requestId: string;
}>;

/** A server-created grant is bound to one operation, context and catalogue entry.
 * Private fields prevent fabrication/serialization. The database dispatch claim
 * enforces one-use execution across application instances; validation is repeatable.
 */
class CommandCapability {
  #execution: ExecutionAuthorizationContext;
  #metadata: CommandAuthorizationMetadata;
  #profile: PolicyProfile;
  #approvalId: string | undefined;

  constructor(key: symbol, execution: ExecutionAuthorizationContext, context: ToolContext, commandKey: string, profile: PolicyProfile, operationId: string, approvalId?: string) {
    if (key !== MINT_COMMAND) throw new ExecutionAuthorizationError(403);
    this.#execution = execution;
    this.#profile = profile;
    this.#approvalId = approvalId;
    this.#metadata = Object.freeze({ operationId, executionId: execution.executionId,
      commandKey, actorId: context.actorId, requestId: context.requestId });
    Object.freeze(this);
  }

  static async validate(grant: CommandAuthorization | undefined, execution: ExecutionAuthorizationContext | undefined,
    request: ValidatedCommandRequest): Promise<CommandAuthorizationMetadata> {
    if (!grant || typeof grant !== "object" || !(#execution in grant) ||
        !execution || execution !== grant.#execution) throw new ExecutionAuthorizationError(403);
    const command = validateCommandRequest(request);
    if (command.key !== grant.#metadata.commandKey || request.commandAuthorization !== grant ||
        !getToolPresetForActor(grant.#metadata.actorId).includes("run_command")) throw new ExecutionAuthorizationError(403);
    await revalidateExecutionAuthorization(execution, execution.projectId, "command");
    if (getPolicyProfile() !== grant.#profile) throw new ExecutionAuthorizationError(409, "The command policy has changed.");
    if (grant.#approvalId && !await validateConsumedPrivateCommandApproval(execution, command.key,
      grant.#approvalId, grant.#metadata.operationId, grant.#metadata.actorId)) {
      throw new ExecutionAuthorizationError(403, "The command approval is no longer valid.");
    }
    if (getPolicyProfile() !== grant.#profile) throw new ExecutionAuthorizationError(409, "The command policy has changed.");
    return grant.#metadata;
  }
}

export type CommandAuthorization = CommandCapability;
export type CommandAuthorizationResult =
  | { allowed: true; authorization: CommandAuthorization }
  | { allowed: false; requiresApproval: boolean; reason: string };

/** Called with the server's agent context, never model arguments or request JSON. */
export async function authorizeDevelopmentCommand(context: ToolContext, command: string): Promise<CommandAuthorizationResult> {
  // The lower-level command mechanism never inherits inactive-mode synthetic access.
  if (!context?.authorization) throw new ExecutionAuthorizationError(401);
  await revalidateExecutionAuthorization(context.authorization, context.projectId, "command");
  if (!getToolPresetForActor(context.actorId).includes("run_command")) throw new ExecutionAuthorizationError(403);
  const entry = findDevelopmentCommand(command);
  if (!entry) throw new ExecutionAuthorizationError(403, "Command request is not permitted.");
  const workspace = context.authorization.workspace;
  if (workspace.runtimeType !== "cloud" || workspace.provider !== "daytona" || !workspace.providerWorkspaceId) {
    throw new ExecutionAuthorizationError(503, "Development commands require a registered Daytona workspace.");
  }
  const profile = getPolicyProfile();
  const operationId = randomUUID();
  // Only the explicit autonomous profile waives human approval. All profiles
  // still require genuine authentication, agent permissions and the release gate.
  const approvalRequired = profile !== "autonomous";
  const approvalId = approvalRequired ? context.approvalId : undefined;
  const approved = !approvalRequired || (Boolean(approvalId) && await consumePrivateCommandApproval(
    context.authorization, entry.key, approvalId!, operationId, context.actorId));
  appendAuditEvent({ id: randomUUID(), at: new Date().toISOString(), actorId: context.actorId,
    actorRole: "agent", action: "policy.check", outcome: approved ? "allow" : "deny",
    requestId: context.requestId, reason: approved ? "scoped command policy allowed" : "scoped command approval required",
    metadata: { profile, operationId, projectId: context.projectId, commandKey: entry.key,
      approvalRequired, approvalConsumed: approvalRequired && approved } });
  if (!approved) return { allowed: false, requiresApproval: true,
    reason: "A valid approval for this exact command and workspace is required." };
  // Consume once, then revalidate before minting. A failed/uncertain grant is never
  // replayed automatically; its consumed approval remains an audit record.
  await revalidateExecutionAuthorization(context.authorization, context.projectId, "command");
  if (getPolicyProfile() !== profile) throw new ExecutionAuthorizationError(409, "The command policy has changed.");
  return { allowed: true, authorization: new CommandCapability(MINT_COMMAND, context.authorization,
    context, entry.key, profile, operationId, approvalId) };
}

export async function validateCommandAuthorization(grant: CommandAuthorization | undefined,
  execution: ExecutionAuthorizationContext | undefined, request: ValidatedCommandRequest): Promise<CommandAuthorizationMetadata> {
  return CommandCapability.validate(grant, execution, request);
}
