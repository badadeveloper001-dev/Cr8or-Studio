import "server-only";

/**
 * One staging switch controls both authentication services and API enforcement.
 * Only an entirely absent configuration (or a lone explicit false) is inactive.
 * Partial, empty, or malformed configuration must reach the strict validator,
 * never the legacy inactive path. Read per request; do not cache authorization.
 */
export function getPrivateAuthMode(): "inactive" | "required" {
  const enabled = process.env.CR8OR_PRIVATE_AUTH_ENABLED;
  const hasPrivateConfiguration = process.env.CR8OR_PRIVATE_AUTH_ORIGIN !== undefined ||
    process.env.CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY !== undefined;
  return !hasPrivateConfiguration && (enabled === undefined || enabled === "false")
    ? "inactive"
    : "required";
}
