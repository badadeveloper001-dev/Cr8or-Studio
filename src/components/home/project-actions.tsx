"use client";

import { useState } from "react";
import { FolderGit2, FolderOpen, FolderPlus } from "lucide-react";

import { Button } from "@/components/ui/button";

type ProjectActionProps = {
  isBusy: boolean;
  onCreate: (name: string) => void;
  onOpen: (path: string) => void;
  onClone: (repositoryUrl: string) => void;
};

function ActionRow({
  icon,
  label,
  placeholder,
  actionLabel,
  busyLabel,
  isBusy,
  onSubmit,
}: {
  icon: React.ReactNode;
  label: string;
  placeholder: string;
  actionLabel: string;
  busyLabel: string;
  isBusy: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const canSubmit = value.trim().length > 0 && !isBusy;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const next = value.trim();
        if (!next || isBusy) return;
        onSubmit(next);
      }}
      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center"
    >
      <div className="flex items-center gap-2.5 sm:w-48 sm:shrink-0">
        <span aria-hidden="true" className="text-text-muted">
          {icon}
        </span>
        <span className="text-sm font-medium text-text-primary">{label}</span>
      </div>
      <input
        aria-label={label}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        className="h-10 w-full min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
      />
      <Button type="submit" variant="outline" size="default" disabled={!canSubmit} className="h-10 shrink-0 rounded-md sm:w-36">
        {isBusy ? busyLabel : actionLabel}
      </Button>
    </form>
  );
}

export function ProjectActions({ isBusy, onCreate, onOpen, onClone }: ProjectActionProps) {
  return (
    <div className="divide-y divide-border-strong border-y border-border-strong">
      <ActionRow
        icon={<FolderPlus className="h-4 w-4" />}
        label="New project"
        placeholder="Project name"
        actionLabel="Create"
        busyLabel="Creating..."
        isBusy={isBusy}
        onSubmit={onCreate}
      />
      <ActionRow
        icon={<FolderOpen className="h-4 w-4" />}
        label="Open project"
        placeholder="Project ID, path, or GitHub repository URL"
        actionLabel="Open"
        busyLabel="Opening..."
        isBusy={isBusy}
        onSubmit={onOpen}
      />
      <ActionRow
        icon={<FolderGit2 className="h-4 w-4" />}
        label="Clone repository"
        placeholder="https://github.com/org/repo.git"
        actionLabel="Clone"
        busyLabel="Cloning..."
        isBusy={isBusy}
        onSubmit={onClone}
      />
    </div>
  );
}
