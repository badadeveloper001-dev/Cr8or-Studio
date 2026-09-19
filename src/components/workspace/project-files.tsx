"use client";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileCode, Folder, RefreshCw } from "lucide-react";
import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { projectIdFor } from "@/lib/workspace/project-ref";

type Entry = { name: string; type: "file" | "directory" };
function Directory({ projectId, directory, depth = 0 }: { projectId: string; directory: string; depth?: number }) {
  const { openTabFromExplorer } = useWorkspaceControllerContext();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ projectId, path: directory, kind: "list" });
    fetch(`/api/files?${query}`, { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to load files.");
      if (!controller.signal.aborted) setEntries(data.files || []);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, directory, revision]);
  if (loading) return <p className="p-3 text-xs text-text-muted">Loading files…</p>;
  if (error) return <div className="p-3 text-xs"><p role="alert" className="text-danger">{error}</p><button className="mt-2 underline" onClick={() => setRevision(value => value + 1)}>Retry</button></div>;
  return <div>
    {depth === 0 ? <button className="flex items-center gap-2 p-2 text-xs text-text-muted" onClick={() => setRevision(value => value + 1)}><RefreshCw className="h-3 w-3" />Refresh files</button> : null}
    {entries.length === 0 ? <p className="p-3 text-xs text-text-muted">This folder is empty.</p> : entries.map(entry => {
      const filePath = directory === "." ? entry.name : `${directory}/${entry.name}`;
      const open = expanded.has(filePath);
      return <div key={filePath}>
        <button className="flex w-full items-center gap-2 py-1.5 pr-2 text-left text-xs hover:bg-surface-muted" style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => entry.type === "file" ? openTabFromExplorer(filePath) : setExpanded(previous => { const next = new Set(previous); if (next.has(filePath)) next.delete(filePath); else next.add(filePath); return next; })}>
          {entry.type === "directory" ? <>{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}<Folder className="h-3 w-3" /></> : <FileCode className="h-3 w-3" />}
          <span className="truncate">{entry.name}</span>
        </button>
        {entry.type === "directory" && open ? <Directory projectId={projectId} directory={filePath} depth={depth + 1} /> : null}
      </div>;
    })}
  </div>;
}

export function ProjectFiles() {
  const { currentProject } = useWorkspaceControllerContext();
  const projectId = projectIdFor(currentProject);
  return <nav aria-label="File explorer"><p className="border-b border-border-strong p-3 text-xs font-medium">{currentProject.name}</p><Directory key={projectId} projectId={projectId} directory="." /></nav>;
}
