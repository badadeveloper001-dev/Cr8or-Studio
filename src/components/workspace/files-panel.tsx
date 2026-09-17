"use client";

import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  X,
} from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { cn } from "@/lib/utils";

type ExplorerNode = {
  id: string;
  name: string;
  kind: "folder" | "file";
  children?: ExplorerNode[];
};

const EXPLORER_TREE: ExplorerNode[] = [
  {
    id: "src",
    name: "src",
    kind: "folder",
    children: [
      {
        id: "app",
        name: "app",
        kind: "folder",
        children: [
          { id: "src/app/page.tsx", name: "page.tsx", kind: "file" },
          { id: "src/app/layout.tsx", name: "layout.tsx", kind: "file" },
        ],
      },
      {
        id: "components",
        name: "components",
        kind: "folder",
        children: [{ id: "src/components/workspace/workspace-shell.tsx", name: "workspace-shell.tsx", kind: "file" }],
      },
      {
        id: "lib",
        name: "lib",
        kind: "folder",
        children: [{ id: "src/lib/agents/orchestrator.ts", name: "orchestrator.ts", kind: "file" }],
      },
    ],
  },
  { id: "README.md", name: "README.md", kind: "file" },
  { id: "package.json", name: "package.json", kind: "file" },
];

function TreeNode({
  node,
  depth,
  collapsed,
  onToggle,
  onOpenFile,
}: {
  node: ExplorerNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpenFile: (id: string) => void;
}) {
  const isCollapsed = collapsed.has(node.id);
  const hasChildren = Boolean(node.children?.length);

  return (
    <div>
      <button
        type="button"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (node.kind === "folder" ? onToggle(node.id) : onOpenFile(node.id))}
        className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-xs text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
      >
        {node.kind === "folder" ? (
          isCollapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )
        ) : (
          <span className="inline-block h-3 w-3 shrink-0" />
        )}
        {node.kind === "folder" ? (
          isCollapsed ? (
            <Folder className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          )
        ) : (
          <FileCode className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
        {hasChildren ? <span className="ml-auto text-[10px] text-text-muted">{node.children?.length}</span> : null}
      </button>
      {node.kind === "folder" && !isCollapsed && node.children ? (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FilesPanel() {
  const {
    collapsedFolders,
    toggleFolder,
    openTabFromExplorer,
    openTabs,
    activeTabId,
    setActiveTabId,
    closeTab,
    currentProject,
  } = useWorkspaceControllerContext();

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-border-strong px-3 py-2">
        <p className="truncate text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
          {currentProject.name}
        </p>
      </div>

      <nav className="p-1" aria-label="File explorer">
        {EXPLORER_TREE.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            collapsed={collapsedFolders}
            onToggle={toggleFolder}
            onOpenFile={openTabFromExplorer}
          />
        ))}
      </nav>

      <div className="border-t border-border-strong">
        <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Open editors
        </p>
        {openTabs.length === 0 ? (
          <p className="px-3 py-2 text-xs text-text-muted">No open files.</p>
        ) : (
          <ul className="px-1 pb-1">
            {openTabs.map((tab) => (
              <li key={tab.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    tab.id === activeTabId
                      ? "bg-surface-raised text-text-primary"
                      : "text-text-secondary hover:bg-surface-muted hover:text-text-primary",
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{tab.title}</span>
                  {tab.dirty ? <span className="text-[10px] text-warning">●</span> : null}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => closeTab(tab.id)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
