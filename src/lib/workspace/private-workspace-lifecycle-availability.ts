import "server-only";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";

/** No environment, policy, request, model or legacy identity can open this
 * release gate. Provider identity, snapshot and timeout behavior require a
 * separately authorized isolated verification before a reviewed code change. */
export function assertWorkspaceLifecycleAvailable(): void {
  throw new ExecutionAuthorizationError(503, "Private workspace lifecycle operations are unavailable pending provider verification.");
}

/** The SDK username/password clone API cannot establish scoped, ephemeral,
 * non-persistent repository credentials. Never forward the application token. */
export function assertPrivateRepositoryCloningAvailable(): void {
  throw new ExecutionAuthorizationError(503, "Private repository cloning is unavailable pending secure credential transport.");
}
