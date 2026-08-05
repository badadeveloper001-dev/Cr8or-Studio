export type FeatureFlagName =
  | "authGuard"
  | "policyEngine"
  | "sandboxRuntime"
  | "auditLog"
  | "sliEndpoint";

type FeatureFlagDefinition = {
  envKey: string;
  description: string;
  defaultValue: boolean;
};

const FEATURE_FLAG_DEFINITIONS: Record<FeatureFlagName, FeatureFlagDefinition> = {
  authGuard: {
    envKey: "CR8OR_FEATURE_AUTH_GUARD",
    description: "Enable auth/session gate checks in protected routes.",
    defaultValue: false,
  },
  policyEngine: {
    envKey: "CR8OR_FEATURE_POLICY_ENGINE",
    description: "Enable policy profile and approval-gate evaluation.",
    defaultValue: false,
  },
  sandboxRuntime: {
    envKey: "CR8OR_FEATURE_SANDBOX_RUNTIME",
    description: "Run workspace commands through sandbox isolation.",
    defaultValue: false,
  },
  auditLog: {
    envKey: "CR8OR_FEATURE_AUDIT_LOG",
    description: "Persist audit events for sensitive operations.",
    defaultValue: false,
  },
  sliEndpoint: {
    envKey: "CR8OR_FEATURE_SLI_ENDPOINT",
    description: "Expose baseline in-memory SLI metrics endpoint.",
    defaultValue: true,
  },
};

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function isFeatureEnabled(name: FeatureFlagName): boolean {
  const definition = FEATURE_FLAG_DEFINITIONS[name];
  return parseBoolean(process.env[definition.envKey], definition.defaultValue);
}

export function getFeatureFlags(): Record<FeatureFlagName, boolean> {
  return {
    authGuard: isFeatureEnabled("authGuard"),
    policyEngine: isFeatureEnabled("policyEngine"),
    sandboxRuntime: isFeatureEnabled("sandboxRuntime"),
    auditLog: isFeatureEnabled("auditLog"),
    sliEndpoint: isFeatureEnabled("sliEndpoint"),
  };
}

export function getFeatureFlagDefinitions() {
  return FEATURE_FLAG_DEFINITIONS;
}
