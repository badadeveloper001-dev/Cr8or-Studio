"use client";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { Button } from "@/components/ui/button";
import type { DelegationPolicy, PolicyProfile } from "@/hooks/use-workspace-controller";

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-border-strong bg-surface px-2.5 text-xs text-text-primary outline-none transition-colors focus:border-accent";

const CHECK_ROWS: Array<{ key: keyof NonNullable<ReturnType<typeof useWorkspaceControllerContext>["secretReadiness"]>["checks"]; label: string }> = [
  { key: "ai", label: "AI" },
  { key: "openai", label: "OpenAI" },
  { key: "anthropic", label: "Anthropic" },
  { key: "deepseek", label: "DeepSeek" },
  { key: "github", label: "GitHub" },
  { key: "vercel", label: "Vercel" },
  { key: "supabase", label: "Supabase" },
];

export function SettingsPanel() {
  const {
    delegationPolicy,
    setDelegationPolicy,
    policyProfile,
    updatePolicyProfile,
    secretReadiness,
    secretReadinessStatus,
    isSecretReadinessBusy,
    loadSecretReadiness,
  } = useWorkspaceControllerContext();

  const missingEntries = secretReadiness
    ? [
        ...secretReadiness.missing.ai,
        ...secretReadiness.missing.github,
        ...secretReadiness.missing.vercel,
        ...secretReadiness.missing.supabase,
      ]
    : [];

  return (
    <div className="space-y-5 p-3">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Delegation</p>
        <select
          value={delegationPolicy}
          onChange={(event) => setDelegationPolicy(event.target.value as DelegationPolicy)}
          aria-label="Delegation policy"
          className={INPUT_CLASS}
        >
          <option value="auto">Auto delegate</option>
          <option value="ask">Ask before run</option>
          <option value="chat-only">Chat only</option>
        </select>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Policy profile</p>
        <select
          value={policyProfile}
          onChange={(event) => void updatePolicyProfile(event.target.value as PolicyProfile)}
          aria-label="Policy profile"
          className={INPUT_CLASS}
        >
          <option value="strict">strict</option>
          <option value="balanced">balanced</option>
          <option value="autonomous">autonomous</option>
        </select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Secrets readiness</p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void loadSecretReadiness()}
            disabled={isSecretReadinessBusy}
          >
            {isSecretReadinessBusy ? "Checking..." : "Check"}
          </Button>
        </div>

        {secretReadiness ? (
          <div className="space-y-1.5">
            <p className="text-[11px] text-text-secondary">Provider: {secretReadiness.provider}</p>
            <ul className="grid grid-cols-2 gap-1">
              {CHECK_ROWS.map(({ key, label }) => (
                <li key={key} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-text-secondary">{label}</span>
                  <span className={secretReadiness.checks[key] ? "text-success" : "text-danger"}>
                    {secretReadiness.checks[key] ? "ready" : "missing"}
                  </span>
                </li>
              ))}
            </ul>
            {missingEntries.length > 0 ? (
              <p className="text-[11px] leading-relaxed text-danger">Missing: {missingEntries.join(", ")}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-text-muted">
            Run a readiness check to confirm AI, GitHub, and Vercel credentials.
          </p>
        )}

        {secretReadinessStatus ? <p className="text-[11px] text-text-muted">{secretReadinessStatus}</p> : null}
      </div>
    </div>
  );
}
