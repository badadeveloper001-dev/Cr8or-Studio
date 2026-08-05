import { SecretName } from "@/lib/security/secrets";

const GENERIC_SECRET_PATTERNS: RegExp[] = [
  /\b(ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\b(?:xoxb|xoxp)-[A-Za-z0-9-]{20,}\b/g,
  /\b[A-Za-z0-9_\/\+=-]{32,}\b/g,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(input: string, extras: string[] = []): string {
  let output = input;

  const envSecretNames: SecretName[] = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "VERCEL_TOKEN",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ];

  for (const key of envSecretNames) {
    const value = process.env[key]?.trim();
    if (!value || value.length < 6) continue;
    output = output.replace(new RegExp(escapeRegExp(value), "g"), `[REDACTED:${key}]`);
  }

  for (const extra of extras) {
    const value = extra.trim();
    if (!value || value.length < 6) continue;
    output = output.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED:runtime]");
  }

  for (const pattern of GENERIC_SECRET_PATTERNS) {
    output = output.replace(pattern, "[REDACTED:pattern]");
  }

  return output;
}
