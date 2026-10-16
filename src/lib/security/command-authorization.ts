import "server-only";

import { randomUUID } from "node:crypto";
import { getToolPresetForActor, type ToolContext } from "@/lib/agents/tools";
import { findDevelopmentCommand, validateCommandRequest } from "@/lib/security/command-catalogue";
import { ExecutionAuthorizationError, revalidateExecutionAuthorization, type ExecutionAuthorizationContext } from "@/lib/security/execution-context";
import { evaluatePolicyGuard, getPolicyProfile, type PolicyProfile } from "@/lib/security/policy";
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

  constructor(key: symbol, execution: ExecutionAuthorizationContext, context: ToolContext, commandKey: string, profile: PolicyProfile) {
    if (key !== MINT_COMMAND) throw new ExecutionAuthorizationError(403);
    this.#execution = execution;
    this.#profile = profile;
    this.#metadata = Object.freeze({ operationId: randomUUID(), executionId: execution.executionId,
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
  const policy = evaluatePolicyGuard({ action: "commands.execute", actorId: context.actorId,
    actorRole: "agent", requestId: context.requestId, approvalId: context.approvalId });
  if (!policy.allowed) return { allowed: false, requiresApproval: policy.approvalRequired, reason: policy.reason };
  // Approval evaluation cannot extend a session that ended while the guard ran.
  await revalidateExecutionAuthorization(context.authorization, context.projectId, "command");
  return { allowed: true, authorization: new CommandCapability(MINT_COMMAND, context.authorization, context, entry.key, policy.profile) };
}

export async function validateCommandAuthorization(grant: CommandAuthorization | undefined,
  execution: ExecutionAuthorizationContext | undefined, request: ValidatedCommandRequest): Promise<CommandAuthorizationMetadata> {
  return CommandCapability.validate(grant, execution, request);
}
