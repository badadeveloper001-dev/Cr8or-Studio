"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  Bug,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileCode,
  FileText,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  Play,
  Search,
  SquareTerminal,
  StopCircle,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { OrchestrationProgressEvent } from "@/lib/agents/orchestrator";
import { AgentExecutionState, AgentId, AgentStatus, AgentTask, OrchestrationResult } from "@/lib/agents/types";

const SEED_PROMPT = "Build a full-stack SaaS authentication system with social login (GitHub, Google), RBAC, session management, and audit logs.";

const STATUS_COLORS: Record<AgentStatus, string> = {
  completed: "bg-emerald-400",
  running: "bg-cyan-400 animate-pulse",
  failed: "bg-red-400",
  blocked: "bg-amber-400",
  pending: "bg-zinc-600",
  idle: "bg-zinc-700",
};

function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[status]}`} />;
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
      <div
        className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all duration-500"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentExecutionState }) {
  return (
    <article className="vscode-card animate-rise rounded-md p-2.5">
      <div className="mb-1 flex items-center gap-2">
        <StatusDot status={agent.status} />
        <span className="flex-1 truncate text-xs font-medium text-[#cccccc]">{agent.name}</span>
        <span className="text-[10px] capitalize text-[#858585]">{agent.status}</span>
      </div>
      <p className="truncate text-[10px] text-[#858585]">{agent.thinking}</p>
      <div className="mt-2">
        <ProgressBar value={agent.progress} />
      </div>
    </article>
  );
}

function AgentOutputPanel({ task }: { task: AgentTask }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-[#3c3c3c] bg-[#252526]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <StatusDot status={task.status as AgentStatus} />
        <span className="flex-1 text-xs font-medium text-[#cccccc]">{task.title}</span>
        <span className="text-[10px] text-[#858585]">{task.agentId}</span>
        {expanded ? <ChevronUp className="h-3 w-3 text-[#858585]" /> : <ChevronDown className="h-3 w-3 text-[#858585]" />}
      </button>
      {expanded && task.output ? (
        <div className="border-t border-[#3c3c3c] px-3 pb-3 pt-2">
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[#cccccc]">{task.output}</pre>
        </div>
      ) : null}
    </div>
  );
}

function SynthesisCard({ title, items }: { title: string; items: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const first = items[0] ?? "No output yet.";
  return (
    <div className="vscode-card rounded-md p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[#858585]">{title}</h3>
        {items.length > 0 && (
          <button type="button" className="text-[10px] text-[#858585] hover:text-[#cccccc]" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "less" : "more"}
          </button>
        )}
      </div>
      <p className="line-clamp-3 text-xs text-[#cccccc]">{first.slice(0, 220)}{first.length > 220 ? "..." : ""}</p>
      {expanded && items.length > 1 && (
        <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-[#858585]">{items.join("\n\n---\n\n")}</pre>
      )}
    </div>
  );
}

type DashboardMap = Map<AgentId, AgentExecutionState>;

type PanelTab = "terminal" | "problems" | "output" | "debug";

type EditorTab = {
  id: string;
  title: string;
  dirty?: boolean;
};

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
          { id: "page.tsx", name: "page.tsx", kind: "file" },
          { id: "layout.tsx", name: "layout.tsx", kind: "file" },
        ],
      },
      {
        id: "components",
        name: "components",
        kind: "folder",
        children: [{ id: "workspace-shell.tsx", name: "workspace-shell.tsx", kind: "file" }],
      },
      {
        id: "lib",
        name: "lib",
        kind: "folder",
        children: [{ id: "orchestrator.ts", name: "orchestrator.ts", kind: "file" }],
      },
    ],
  },
  { id: "README.md", name: "README.md", kind: "file" },
  { id: "package.json", name: "package.json", kind: "file" },
];

function renderTree(
  nodes: ExplorerNode[],
  collapsed: Set<string>,
  onToggle: (id: string) => void,
  depth = 0,
) {
  return nodes.map((node) => {
    const isCollapsed = collapsed.has(node.id);
    const hasChildren = Boolean(node.children?.length);
    const paddingLeft = 10 + depth * 12;
    return (
      <div key={node.id}>
        <button
          type="button"
          className="vscode-tree-item flex items-center gap-1.5"
          style={{ paddingLeft }}
          onClick={() => {
            if (node.kind === "folder") {
              onToggle(node.id);
            }
          }}
        >
          {node.kind === "folder" ? (
            isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
          ) : (
            <span className="inline-block h-3 w-3" />
          )}
          {node.kind === "folder" ? (
            isCollapsed ? <Folder className="h-3.5 w-3.5" /> : <FolderOpen className="h-3.5 w-3.5" />
          ) : (
            <FileCode className="h-3.5 w-3.5" />
          )}
          <span className="truncate">{node.name}</span>
          {hasChildren ? <span className="ml-auto text-[10px] text-[#6b6b6b]">{node.children?.length}</span> : null}
        </button>
        {node.kind === "folder" && !isCollapsed && node.children
          ? renderTree(node.children, collapsed, onToggle, depth + 1)
          : null}
      </div>
    );
  });
}

export function WorkspaceShell() {
  const [prompt, setPrompt] = useState(SEED_PROMPT);
  const [isRunning, setIsRunning] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardMap>(new Map());
  const [timeline, setTimeline] = useState<AgentTask[]>([]);
  const [synthesis, setSynthesis] = useState<OrchestrationResult["synthesis"] | null>(null);
  const [statusLine, setStatusLine] = useState("Awaiting orchestration command.");
  const [error, setError] = useState<string | null>(null);
  const [activeBottomTab, setActiveBottomTab] = useState<PanelTab>("terminal");
  const [showExplorer, setShowExplorer] = useState(true);
  const [showRightPane, setShowRightPane] = useState(true);
  const [showBottomPanel, setShowBottomPanel] = useState(true);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set(["src"]));
  const [openTabs, setOpenTabs] = useState<EditorTab[]>([
    { id: "workspace-shell.tsx", title: "workspace-shell.tsx", dirty: true },
    { id: "orchestrator.ts", title: "orchestrator.ts" },
    { id: "agent-output.log", title: "agent-output.log" },
  ]);
  const [activeTabId, setActiveTabId] = useState("workspace-shell.tsx");
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const paletteInputRef = useRef<HTMLInputElement | null>(null);

  const updateAgent = useCallback((state: AgentExecutionState) => {
    setDashboard((prev) => new Map(prev).set(state.agentId, state));
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setIsPaletteOpen((prev) => !prev);
      }
      if (event.key === "Escape") {
        setIsPaletteOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (isPaletteOpen) {
      setTimeout(() => paletteInputRef.current?.focus(), 0);
    }
  }, [isPaletteOpen]);

  const commandItems = [
    {
      id: "run-agents",
      label: "Cr8or: Run Agents",
      run: () => {
        setIsPaletteOpen(false);
        runOrchestration();
      },
    },
    {
      id: "toggle-explorer",
      label: showExplorer ? "View: Hide Explorer" : "View: Show Explorer",
      run: () => {
        setShowExplorer((prev) => !prev);
        setIsPaletteOpen(false);
      },
    },
    {
      id: "toggle-right",
      label: showRightPane ? "View: Hide Agent Panel" : "View: Show Agent Panel",
      run: () => {
        setShowRightPane((prev) => !prev);
        setIsPaletteOpen(false);
      },
    },
    {
      id: "toggle-bottom",
      label: showBottomPanel ? "View: Hide Bottom Panel" : "View: Show Bottom Panel",
      run: () => {
        setShowBottomPanel((prev) => !prev);
        setIsPaletteOpen(false);
      },
    },
    {
      id: "focus-prompt",
      label: "Editor: Focus Master Task Input",
      run: () => {
        promptRef.current?.focus();
        setIsPaletteOpen(false);
      },
    },
  ];

  const filteredCommands = commandItems.filter((item) =>
    item.label.toLowerCase().includes(paletteQuery.trim().toLowerCase()),
  );

  function toggleFolder(id: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function closeTab(id: string) {
    setOpenTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== id);
      if (next.length === 0) {
        return prev;
      }
      if (activeTabId === id) {
        setActiveTabId(next[0].id);
      }
      return next;
    });
  }

  async function runOrchestration() {
    if (isRunning) {
      abortRef.current?.abort();
      return;
    }

    abortRef.current = new AbortController();
    setIsRunning(true);
    setError(null);
    setDashboard(new Map());
    setTimeline([]);
    setSynthesis(null);
    setStatusLine("Orchestrator is distributing work to agents…");

    try {
      const response = await fetch("/api/orchestrate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, projectId: "default-project" }),
        signal: abortRef.current.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Stream failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.replace(/^data: /, "").trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as OrchestrationProgressEvent;
            if (event.type === "agent_update") {
              updateAgent(event.data);
            } else if (event.type === "batch_complete") {
              setStatusLine(`Batch ${event.batchIndex + 1}/${event.total} complete.`);
            } else if (event.type === "done") {
              setTimeline(event.result.timeline);
              setSynthesis(event.result.synthesis);
              setStatusLine(event.result.summary);
            } else if (event.type === "error") {
              setError(event.message);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Unknown error.");
      }
      setStatusLine("Orchestration stopped.");
    } finally {
      setIsRunning(false);
    }
  }

  const agentList = Array.from(dashboard.values());
  const running = agentList.filter((a) => a.status === "running").length;
  const completed = agentList.filter((a) => a.status === "completed").length;

  return (
    <div
      className="vscode-shell min-h-screen w-full text-[#cccccc]"
      style={{ gridTemplateColumns: showExplorer ? "48px 260px 1fr" : "48px 1fr" }}
    >
      <aside className="vscode-activitybar">
        <button type="button" className="vscode-activity-btn active"><Files className="h-4 w-4" /></button>
        <button type="button" className="vscode-activity-btn"><Search className="h-4 w-4" /></button>
        <button type="button" className="vscode-activity-btn"><GitBranch className="h-4 w-4" /></button>
        <button type="button" className="vscode-activity-btn"><Bug className="h-4 w-4" /></button>
        <button type="button" className="vscode-activity-btn"><Boxes className="h-4 w-4" /></button>
      </aside>

      {showExplorer ? (
        <aside className="vscode-sidebar">
          <div className="vscode-panel-header">EXPLORER</div>
          <div className="px-3 py-2 text-[11px] text-[#858585]">CR8OR STUDIO</div>
          <nav className="px-1">{renderTree(EXPLORER_TREE, collapsedFolders, toggleFolder)}</nav>

          <div className="vscode-panel-header mt-3">AGENT HEALTH</div>
          <div className="space-y-1 px-3 py-2">
            {agentList.length === 0 ? (
              <p className="text-[11px] text-[#6b6b6b]">No active run.</p>
            ) : (
              agentList.map((agent) => (
                <div key={agent.agentId} className="flex items-center gap-2 text-[11px]">
                  <StatusDot status={agent.status} />
                  <span className="flex-1 truncate text-[#b8b8b8]">{agent.name}</span>
                  <span className="text-[#6b6b6b]">{agent.progress}%</span>
                </div>
              ))
            )}
          </div>
        </aside>
      ) : null}

      <main className="vscode-workbench">
        <div className="vscode-titlebar">
          <span className="text-[11px] text-[#9f9f9f]">Cr8or Studio</span>
          <div className="flex items-center gap-2">
            {isRunning ? (
              <span className="text-[11px] text-[#858585]">
                {running > 0 ? `${running} running` : ""}
                {completed > 0 ? ` · ${completed} done` : ""}
              </span>
            ) : null}
            <Button
              className="h-7 gap-1.5 rounded-sm border border-[#3c3c3c] bg-[#0e639c] px-3 text-xs text-white hover:bg-[#1177bb]"
              onClick={runOrchestration}
            >
              {isRunning ? <StopCircle className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {isRunning ? "Stop" : "Run Agents"}
            </Button>
          </div>
        </div>

        <div className="vscode-tabs">
          {openTabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={`vscode-tab flex items-center gap-2 ${activeTabId === tab.id ? "active" : ""}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <FileText className="h-3 w-3" />
              <span>{tab.title}</span>
              {tab.dirty ? <span className="text-[9px] text-[#f3d88c]">●</span> : null}
              {openTabs.length > 1 ? (
                <span
                  className="rounded p-0.5 hover:bg-[#3a3d41]"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X className="h-3 w-3" />
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div
          className="vscode-editor-region"
          style={{ gridTemplateColumns: showRightPane ? "1fr 360px" : "1fr" }}
        >
          <section className="vscode-editor-pane">
            <div className="vscode-editor-toolbar">
              <span className="text-[11px] text-[#858585]">MASTER TASK INPUT</span>
              {isRunning ? <Loader2 className="h-3 w-3 animate-spin text-[#858585]" /> : null}
            </div>
            <div className="vscode-editor-surface">
              <div className="vscode-gutter">
                {Array.from({ length: 8 }).map((_, idx) => (
                  <span key={idx}>{idx + 1}</span>
                ))}
              </div>
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={8}
                className="vscode-textarea"
                placeholder="Describe what the engineering team should build..."
              />
            </div>
            {error ? <p className="px-3 py-2 text-xs text-[#f48771]">{error}</p> : null}

            <div className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-3">
              <SynthesisCard title="Requirements" items={synthesis?.requirements ?? []} />
              <SynthesisCard title="Architecture" items={synthesis?.architecture ?? []} />
              <SynthesisCard title="Quality" items={synthesis?.quality ?? []} />
            </div>
          </section>

          {showRightPane ? (
            <aside className="vscode-rightpane">
              <div className="vscode-panel-header">LIVE AGENTS</div>
              <div className="space-y-2 p-3">
                {agentList.length === 0 ? (
                  <p className="text-xs text-[#6b6b6b]">Press Run Agents to start autonomous execution.</p>
                ) : (
                  agentList.map((agent) => <AgentCard key={agent.agentId} agent={agent} />)
                )}
              </div>

              <div className="vscode-panel-header">OUTPUTS</div>
              <div className="space-y-2 overflow-y-auto p-3">
                {timeline.length === 0 ? (
                  <p className="text-xs text-[#6b6b6b]">Agent outputs appear here after each work package.</p>
                ) : (
                  timeline.map((task) => <AgentOutputPanel key={task.id} task={task} />)
                )}
              </div>
            </aside>
          ) : null}
        </div>

        {showBottomPanel ? (
          <div className="vscode-bottompanel">
            <div className="vscode-bottomtabs">
              <button
                type="button"
                className={`vscode-bottomtab ${activeBottomTab === "terminal" ? "active" : ""}`}
                onClick={() => setActiveBottomTab("terminal")}
              >
                Terminal
              </button>
              <button
                type="button"
                className={`vscode-bottomtab ${activeBottomTab === "problems" ? "active" : ""}`}
                onClick={() => setActiveBottomTab("problems")}
              >
                Problems
              </button>
              <button
                type="button"
                className={`vscode-bottomtab ${activeBottomTab === "output" ? "active" : ""}`}
                onClick={() => setActiveBottomTab("output")}
              >
                Output
              </button>
              <button
                type="button"
                className={`vscode-bottomtab ${activeBottomTab === "debug" ? "active" : ""}`}
                onClick={() => setActiveBottomTab("debug")}
              >
                Debug Console
              </button>
            </div>

            <div className="vscode-bottomcontent">
              {activeBottomTab === "terminal" ? (
                <pre className="font-mono text-[11px] text-[#cccccc]">
                  {`$ orchestrator run\n${statusLine}\n${error ? `error: ${error}` : "ready"}`}
                </pre>
              ) : null}
              {activeBottomTab === "problems" ? (
                <div className="text-[11px] text-[#cccccc]">
                  {error ? <p className="text-[#f48771]">1 error: {error}</p> : <p>No problems have been detected.</p>}
                </div>
              ) : null}
              {activeBottomTab === "output" ? (
                <div className="space-y-1 text-[11px] text-[#cccccc]">
                  {timeline.length === 0 ? <p>No output yet.</p> : timeline.map((task) => <p key={task.id}>[{task.agentId}] {task.status}</p>)}
                </div>
              ) : null}
              {activeBottomTab === "debug" ? (
                <pre className="font-mono text-[11px] text-[#cccccc]">{JSON.stringify({ running, completed, activeTabId }, null, 2)}</pre>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="vscode-statusbar">
          <div className="flex items-center gap-2">
            <SquareTerminal className="h-3 w-3" />
            <span>Cr8or Studio</span>
          </div>
          <span className="truncate">{statusLine}</span>
          <span>TypeScript</span>
        </div>
      </main>

      {isPaletteOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[11vh]" onClick={() => setIsPaletteOpen(false)}>
          <div
            className="w-[680px] max-w-[92vw] overflow-hidden rounded-md border border-[#3c3c3c] bg-[#252526] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-[#3c3c3c] px-3 py-2">
              <input
                ref={paletteInputRef}
                value={paletteQuery}
                onChange={(event) => setPaletteQuery(event.target.value)}
                placeholder="Type a command"
                className="w-full bg-transparent text-sm text-[#cccccc] outline-none placeholder:text-[#6b6b6b]"
              />
            </div>
            <div className="max-h-[46vh] overflow-y-auto p-1.5">
              {filteredCommands.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-[#6b6b6b]">No commands found.</p>
              ) : (
                filteredCommands.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    onClick={command.run}
                    className="block w-full rounded px-2 py-1.5 text-left text-xs text-[#cccccc] hover:bg-[#094771]"
                  >
                    {command.label}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
