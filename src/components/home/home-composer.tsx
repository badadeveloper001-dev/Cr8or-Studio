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
    <div>
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = draft.trim();
        if (!value || isRunning) return;
        onSubmit(value);
      }}
      className="rounded-2xl border border-border-strong bg-surface p-5 shadow-[0_8px_32px_-16px_rgba(20,50,45,0.18)] transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10"
    >
      <label htmlFor="home-composer" className="sr-only">
        What are you working on?
      </label>
      <textarea
        id="home-composer"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            const value = draft.trim();
            if (value && !isRunning) onSubmit(value);
          }
        }}
        rows={3}
        placeholder="I want to build..."
        className="block w-full resize-none bg-transparent px-1 py-1 text-[15px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border-strong pt-3">
        <p className="text-xs text-text-muted">Describe your idea in your own words.</p>
        <Button type="submit" size="sm" disabled={!canSubmit} className="gap-2 rounded-lg bg-accent px-4 text-accent-foreground hover:bg-accent/90">
          {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          Let’s create
        </Button>
      </div>
    </form>
    <div className="mt-4 flex flex-wrap gap-2">
      {["Explore this project", "Plan a new feature", "Find and fix a bug"].map((idea) => (
        <button key={idea} type="button" disabled={isRunning} onClick={() => setDraft(idea)} className="rounded-full border border-border bg-surface px-3.5 py-2 text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50">{idea}</button>
      ))}
    </div>
    </div>
  );
}
