import "server-only";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";

/** No runtime, environment, policy or request override. Provider isolation,
 * historical credentials and remote mutation semantics need isolated review. */
export function assertPrivateGitAvailable(): void {
  throw new ExecutionAuthorizationError(503, "Private Git operations await isolated provider and credential verification.");
}
