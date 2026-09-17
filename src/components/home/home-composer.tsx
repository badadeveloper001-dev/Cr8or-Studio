"use client";

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export function HomeComposer({
  initialPrompt,
  isRunning,
  onSubmit,
}: {
  initialPrompt: string;
  isRunning: boolean;
  onSubmit: (prompt: string) => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const canSubmit = draft.trim().length > 0 && !isRunning;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = draft.trim();
        if (!value || isRunning) return;
        onSubmit(value);
      }}
      className="rounded-xl border border-border-strong bg-surface p-3 transition-colors focus-within:border-accent"
    >
      <label htmlFor="home-composer" className="sr-only">
        What are you working on?
      </label>
      <textarea
        id="home-composer"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            const value = draft.trim();
            if (value && !isRunning) onSubmit(value);
          }
        }}
        rows={3}
        placeholder="Describe a feature, fix a bug, refactor a module, or ask a question..."
        className="block w-full resize-none bg-transparent px-1 py-1 text-[15px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border-strong pt-3">
        <p className="text-xs text-text-muted">Cr8or AI plans the work and delegates to specialist agents.</p>
        <Button type="submit" size="sm" disabled={!canSubmit} className="gap-2 rounded-md">
          {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          Start build
        </Button>
      </div>
    </form>
  );
}
