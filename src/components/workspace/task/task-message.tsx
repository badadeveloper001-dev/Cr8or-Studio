"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { cn } from "@/lib/utils";

const MARKDOWN_CLASS = [
  "text-sm leading-7 text-text-secondary break-words",
  "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-text-primary",
  "[&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-text-primary",
  "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-text-primary",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:space-y-1 [&_li]:ml-4 [&_li]:list-disc",
  "[&_a]:text-accent [&_a]:underline",
  "[&_blockquote]:border-l [&_blockquote]:border-border-strong [&_blockquote]:pl-3",
  "[&_code]:rounded [&_code]:bg-surface-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border-strong [&_pre]:bg-surface-muted [&_pre]:p-3",
].join(" ");

export function TaskMessage({
  role,
  content,
  suggestions,
  onSuggestion,
  disabled,
}: {
  role: "user" | "assistant";
  content: string;
  suggestions?: string[];
  onSuggestion?: (suggestion: string) => void;
  disabled?: boolean;
}) {
  if (role === "user") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">You</span>
        <div className="whitespace-pre-wrap break-words rounded-2xl border border-border bg-surface px-5 py-4 text-sm leading-relaxed text-text-primary">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">Cr8or</span>
      <article className={MARKDOWN_CLASS}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
      </article>
      {suggestions && suggestions.length > 0 && onSuggestion ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSuggestion(suggestion)}
              disabled={disabled}
              className={cn(
                "rounded-full border border-border-strong px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary",
                disabled && "cursor-not-allowed opacity-50",
              )}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
