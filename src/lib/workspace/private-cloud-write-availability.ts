import "server-only";

import { ExecutionAuthorizationError } from "@/lib/security/execution-context";

/**
 * Release restriction, not an authentication switch. Remove only in a reviewed
 * change after separately authorized isolated Daytona protocol verification.
 * Environment variables, request data, and owner credentials cannot bypass it.
 */
export function assertPrivateCloudWriteTransportAvailable(): void {
  throw new ExecutionAuthorizationError(503, "Private cloud writes await isolated provider compatibility verification.");
}
