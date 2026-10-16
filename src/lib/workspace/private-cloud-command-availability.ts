import "server-only";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";

/** No environment/client override. Remove only after separately approved isolated
 * Daytona compatibility, credential isolation and cancellation verification. */
export function assertPrivateCloudCommandAvailable(): never {
  throw new ExecutionAuthorizationError(503,
    "Private cloud commands await isolated provider compatibility and isolation verification.");
}
