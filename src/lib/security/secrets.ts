import { randomUUID } from "node:crypto";

import { appendAuditEvent } from "@/lib/security/audit";

export type SecretName =
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "DEEPSEEK_API_KEY"
  | "GITHUB_TOKEN"
  | "GH_TOKEN"
  | "VERCEL_TOKEN"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY";

type SecretDef = {
  requiredFor: string[];
  allowPlaceholder: boolean;
  description: string;
};

const SECRET_DEFS: Record<SecretName, SecretDef> = {
  OPENAI_API_KEY: {
    requiredFor: ["ai:openai"],
    allowPlaceholder: false,
    description: "OpenAI provider API key",
  },
  ANTHROPIC_API_KEY: {
    requiredFor: ["ai:anthropic"],
    allowPlaceholder: false,
    description: "Anthropic provider API key",
  },
  DEEPSEEK_API_KEY: {
    requiredFor: ["ai:deepseek"],
    allowPlaceholder: false,
    description: "DeepSeek provider API key",
  },
  GITHUB_TOKEN: {
    requiredFor: ["github:api"],
    allowPlaceholder: false,
    description: "GitHub REST API token",
  },
  GH_TOKEN: {
    requiredFor: ["github:api"],
    allowPlaceholder: false,
    description: "Alternative GitHub token",
  },
  VERCEL_TOKEN: {
    requiredFor: ["deploy:vercel"],
    allowPlaceholder: false,
    description: "Vercel deployment token",
  },
  NEXT_PUBLIC_SUPABASE_URL: {
    requiredFor: ["auth:supabase"],
    allowPlaceholder: false,
    description: "Supabase project URL",
  },
  NEXT_PUBLIC_SUPABASE_ANON_KEY: {
    requiredFor: ["auth:supabase"],
    allowPlaceholder: false,
    description: "Supabase anon key",
  },
};

function isPlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    lower.includes("your-") ||
    lower.includes("example") ||
    lower === "sk-..." ||
    lower.includes("...")
  );
}

export function isUsableSecret(value: string | undefined | null, allowPlaceholder = false): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!allowPlaceholder && isPlaceholder(trimmed)) return false;
  return true;
}

export function getSecret(name: SecretName, requestId?: string): string | null {
  const raw = process.env[name];
  const usable = isUsableSecret(raw, SECRET_DEFS[name].allowPlaceholder);

  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: "system",
    actorRole: "system",
    action: "secret.access",
    outcome: usable ? "allow" : "deny",
    reason: usable ? `read:${name}` : `missing-or-placeholder:${name}`,
    requestId,
    metadata: {
      secret: name,
      usable,
    },
  });

  return usable ? raw!.trim() : null;
}

export function getSecretWithFallback(names: SecretName[], requestId?: string): { value: string | null; key?: SecretName } {
  for (const name of names) {
    const value = getSecret(name, requestId);
    if (value) {
      return { value, key: name };
    }
  }

  return { value: null };
}

export function getSecretReadiness() {
  const provider = (process.env.AI_PROVIDER ?? "openai").trim().toLowerCase();
  const openAiReady = Boolean(getSecret("OPENAI_API_KEY"));
  const anthropicReady = Boolean(getSecret("ANTHROPIC_API_KEY"));
  const deepseekReady = Boolean(getSecret("DEEPSEEK_API_KEY"));
  const githubReady = Boolean(getSecretWithFallback(["GITHUB_TOKEN", "GH_TOKEN"]).value);
  const vercelReady = Boolean(getSecret("VERCEL_TOKEN"));
  const supabaseUrlReady = Boolean(getSecret("NEXT_PUBLIC_SUPABASE_URL"));
  const supabaseAnonReady = Boolean(getSecret("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

  const aiReady =
    provider === "anthropic"
      ? anthropicReady
      : provider === "deepseek"
        ? deepseekReady
        : openAiReady;

  const aiMissing =
    provider === "anthropic"
      ? anthropicReady
        ? []
        : ["ANTHROPIC_API_KEY"]
      : provider === "deepseek"
        ? deepseekReady
          ? []
          : ["DEEPSEEK_API_KEY"]
        : openAiReady
          ? []
          : ["OPENAI_API_KEY"];

  return {
    provider,
    checks: {
      ai: aiReady,
      openai: openAiReady,
      anthropic: anthropicReady,
      deepseek: deepseekReady,
      github: githubReady,
      vercel: vercelReady,
      supabase: supabaseUrlReady && supabaseAnonReady,
    },
    missing: {
      ai: aiMissing,
      github: githubReady ? [] : ["GITHUB_TOKEN|GH_TOKEN"],
      vercel: vercelReady ? [] : ["VERCEL_TOKEN"],
      supabase: supabaseUrlReady && supabaseAnonReady ? [] : ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    },
  };
}

export function getSecretDefinitions() {
  return SECRET_DEFS;
}
