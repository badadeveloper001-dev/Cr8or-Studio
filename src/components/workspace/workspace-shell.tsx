"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  Bug,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  MessageSquare,
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

type DashboardMap = Map<AgentId, AgentExecutionState>;

type PanelTab = "terminal" | "problems" | "output" | "debug";
type SidebarView = "explorer" | "search" | "source-control" | "problems" | "extensions";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

type TerminalEntry = {
  id: string;
  text: string;
};

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
  onOpenFile: (id: string) => void,
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
              return;
            }
            onOpenFile(node.id);
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
          ? renderTree(node.children, collapsed, onToggle, onOpenFile, depth + 1)
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
  const [statusLine, setStatusLine] = useState("Cr8or AI standing by.");
  const [error, setError] = useState<string | null>(null);
  const [activeSidebar, setActiveSidebar] = useState<SidebarView>("explorer");
  const [activeBottomTab, setActiveBottomTab] = useState<PanelTab>("terminal");
  const [showExplorer, setShowExplorer] = useState(true);
  const [showRightPane, setShowRightPane] = useState(true);
  const [showBottomPanel, setShowBottomPanel] = useState(true);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set(["src"]));
  const [openTabs, setOpenTabs] = useState<EditorTab[]>([
    { id: "cr8or-ai.chat", title: "cr8or-ai.chat" },
    { id: "workspace-shell.tsx", title: "workspace-shell.tsx", dirty: true },
    { id: "orchestrator.ts", title: "orchestrator.ts" },
    { id: "agent-output.log", title: "agent-output.log" },
  ]);
  const [activeTabId, setActiveTabId] = useState("cr8or-ai.chat");
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([
    { id: "boot-1", text: "$ cr8or --boot" },
    { id: "boot-2", text: "Cr8or AI console ready. Type 'help' in terminal input for commands." },
  ]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "assistant-seed",
      role: "assistant",
      content:
        "Cr8or AI online. Share a task and I will delegate execution to the specialist agents automatically.",
      createdAt: Date.now(),
    },
  ]);

  const abortRef = useRef<AbortController | null>(null);
  const paletteInputRef = useRef<HTMLInputElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const updateAgent = useCallback((state: AgentExecutionState) => {
    setDashboard((prev) => new Map(prev).set(state.agentId, state));
  }, []);

  const appendTerminal = useCallback((text: string) => {
    setTerminalEntries((prev) => [
      ...prev,
      {
        id: `t-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        text,
      },
    ]);
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

  useEffect(() => {
    if (!chatScrollRef.current) return;
    chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages]);

  const pushChatMessage = useCallback((role: ChatRole, content: string) => {
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        role,
        content,
        createdAt: Date.now(),
      },
    ]);
  }, []);

  const runOrchestration = useCallback(async (nextPrompt?: string, source: "manual" | "chat" = "manual") => {
    if (isRunning) {
      abortRef.current?.abort();
      appendTerminal("$ cr8or stop");
      appendTerminal("Current orchestration cancelled.");
      return;
    }

    const orchestrationPrompt = nextPrompt?.trim() || prompt.trim();
    if (!orchestrationPrompt) {
      appendTerminal("Prompt is empty. Nothing to run.");
      return;
    }

    if (nextPrompt) {
      setPrompt(nextPrompt);
    }

    abortRef.current = new AbortController();
    setIsRunning(true);
    setError(null);
    setDashboard(new Map());
    setTimeline([]);
    setSynthesis(null);
    setStatusLine("Cr8or AI is delegating work to specialist agents...");
    setActiveBottomTab("terminal");
    appendTerminal(`$ cr8or run --source=${source}`);
    appendTerminal(`Task: ${orchestrationPrompt}`);

    try {
      const response = await fetch("/api/orchestrate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: orchestrationPrompt, projectId: "default-project" }),
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
              appendTerminal(`agent:${event.data.agentId} status=${event.data.status} progress=${event.data.progress}%`);
            } else if (event.type === "batch_complete") {
              const lineText = `Batch ${event.batchIndex + 1}/${event.total} complete.`;
              setStatusLine(lineText);
              appendTerminal(lineText);
            } else if (event.type === "done") {
              setTimeline(event.result.timeline);
              setSynthesis(event.result.synthesis);
              setStatusLine(event.result.summary);
              appendTerminal(`Done: ${event.result.summary}`);
            } else if (event.type === "error") {
              setError(event.message);
              setActiveBottomTab("problems");
              appendTerminal(`error: ${event.message}`);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const message = err instanceof Error ? err.message : "Unknown error.";
        setError(message);
        setActiveBottomTab("problems");
        appendTerminal(`error: ${message}`);
      }
      setStatusLine("Orchestration stopped.");
      appendTerminal("Orchestration stopped.");
    } finally {
      setIsRunning(false);
    }
  }, [appendTerminal, isRunning, prompt, updateAgent]);

  const sendChat = useCallback(async (forcedMessage?: string) => {
    const message = (forcedMessage ?? chatInput).trim();
    if (!message || isChatting || isRunning) {
      return;
    }

    pushChatMessage("user", message);
    appendTerminal(`chat> ${message}`);
    if (!forcedMessage) {
      setChatInput("");
    }
    setIsChatting(true);
    setStatusLine("Cr8or AI is reviewing your request...");

    try {
      const response = await fetch("/api/chat/main", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history: chatMessages.slice(-12).map((entry) => ({ role: entry.role, content: entry.content })),
        }),
      });

      if (!response.ok) {
        throw new Error(`Chat failed: ${response.status}`);
      }

      const data = (await response.json()) as { reply?: string };
      const reply = data.reply?.trim() || "No reply was generated.";
      pushChatMessage("assistant", reply);
      appendTerminal("Cr8or AI prepared delegation plan.");
      setStatusLine("Cr8or AI is delegating execution...");
      await runOrchestration(message, "chat");
    } catch (err) {
      const fallback = err instanceof Error ? err.message : "Unknown chat error.";
      pushChatMessage("assistant", `I could not respond right now: ${fallback}`);
      setStatusLine("Cr8or AI chat failed.");
      setActiveBottomTab("problems");
      appendTerminal(`chat error: ${fallback}`);
    } finally {
      setIsChatting(false);
      setTimeout(() => chatInputRef.current?.focus(), 0);
    }
  }, [appendTerminal, chatInput, chatMessages, isChatting, isRunning, pushChatMessage, runOrchestration]);

  const commandItems = [
    {
      id: "run-agents",
      label: "Cr8or AI: Delegate Current Task",
      run: () => {
        setIsPaletteOpen(false);
        void runOrchestration(prompt, "manual");
      },
    },
    {
      id: "stop-agents",
      label: "Cr8or AI: Stop Current Run",
      run: () => {
        abortRef.current?.abort();
        setIsPaletteOpen(false);
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
      id: "open-chat",
      label: "Cr8or AI: Focus Chat",
      run: () => {
        setIsPaletteOpen(false);
        setActiveTabId("cr8or-ai.chat");
        setIsPaletteOpen(false);
        setTimeout(() => chatInputRef.current?.focus(), 0);
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

  function openTabFromExplorer(id: string) {
    setOpenTabs((prev) => {
      if (prev.some((tab) => tab.id === id)) {
        return prev;
      }
      return [...prev, { id, title: id }];
    });
    setActiveTabId(id);
  }

  function runTerminalCommand() {
    const raw = terminalCommand.trim();
    if (!raw) {
      return;
    }
    setTerminalCommand("");
    appendTerminal(`$ ${raw}`);

    if (raw === "help") {
      appendTerminal("Commands: run, stop, status, clear, chat <text>, show explorer, hide explorer, show panel, hide panel");
      return;
    }
    if (raw === "run") {
      void runOrchestration(prompt, "manual");
      return;
    }
    if (raw === "stop") {
      abortRef.current?.abort();
      return;
    }
    if (raw === "status") {
      appendTerminal(`running=${isRunning} agents=${dashboard.size} completed=${completed}`);
      return;
    }
    if (raw === "clear") {
      setTerminalEntries([{ id: "cleared", text: "Terminal cleared." }]);
      return;
    }
    if (raw === "show explorer") {
      setShowExplorer(true);
      setActiveSidebar("explorer");
      appendTerminal("Explorer opened.");
      return;
    }
    if (raw === "hide explorer") {
      setShowExplorer(false);
      appendTerminal("Explorer hidden.");
      return;
    }
    if (raw === "show panel") {
      setShowRightPane(true);
      appendTerminal("Agent panel opened.");
      return;
    }
    if (raw === "hide panel") {
      setShowRightPane(false);
      appendTerminal("Agent panel hidden.");
      return;
    }
    if (raw.startsWith("chat ")) {
      const content = raw.slice(5).trim();
      if (!content) {
        appendTerminal("Usage: chat <text>");
        return;
      }
      void sendChat(content);
      return;
    }
    appendTerminal(`Unknown command: ${raw}`);
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
        <button
          type="button"
          className={`vscode-activity-btn ${activeSidebar === "explorer" ? "active" : ""}`}
          onClick={() => {
            setShowExplorer(true);
            setActiveSidebar("explorer");
          }}
          title="Explorer"
        >
          <Files className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={`vscode-activity-btn ${activeSidebar === "search" ? "active" : ""}`}
          onClick={() => {
            setShowExplorer(true);
            setActiveSidebar("search");
          }}
          title="Search"
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={`vscode-activity-btn ${activeSidebar === "source-control" ? "active" : ""}`}
          onClick={() => {
            setShowExplorer(true);
            setActiveSidebar("source-control");
          }}
          title="Source Control"
        >
          <GitBranch className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={`vscode-activity-btn ${activeSidebar === "problems" ? "active" : ""}`}
          onClick={() => {
            setShowExplorer(true);
            setActiveSidebar("problems");
            setActiveBottomTab("problems");
          }}
          title="Problems"
        >
          <Bug className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={`vscode-activity-btn ${activeSidebar === "extensions" ? "active" : ""}`}
          onClick={() => {
            setShowExplorer(true);
            setActiveSidebar("extensions");
          }}
          title="Extensions"
        >
          <Boxes className="h-4 w-4" />
        </button>
      </aside>

      {showExplorer ? (
        <aside className="vscode-sidebar">
          <div className="vscode-panel-header">{activeSidebar.toUpperCase().replace("-", " ")}</div>
          {activeSidebar === "explorer" ? (
            <>
              <div className="px-3 py-2 text-[11px] text-[#858585]">CR8OR STUDIO</div>
              <nav className="px-1">{renderTree(EXPLORER_TREE, collapsedFolders, toggleFolder, openTabFromExplorer)}</nav>

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
            </>
          ) : null}

          {activeSidebar === "search" ? (
            <div className="space-y-2 p-3 text-xs text-[#9f9f9f]">
              <p>Use command palette for fast action lookup.</p>
              <Button className="h-7 w-full text-xs" onClick={() => setIsPaletteOpen(true)}>Open Command Palette</Button>
              <p className="text-[11px] text-[#6b6b6b]">Shortcut: Ctrl/Cmd + Shift + P</p>
            </div>
          ) : null}

          {activeSidebar === "source-control" ? (
            <div className="space-y-2 p-3 text-xs text-[#cccccc]">
              <p className="font-medium">Branch: main</p>
              <p className="text-[#9f9f9f]">Open tabs: {openTabs.length}</p>
              <p className="text-[#9f9f9f]">Timeline items: {timeline.length}</p>
            </div>
          ) : null}

          {activeSidebar === "problems" ? (
            <div className="space-y-2 p-3 text-xs text-[#cccccc]">
              {error ? <p className="text-[#f48771]">1 error: {error}</p> : <p>No active issues detected.</p>}
            </div>
          ) : null}

          {activeSidebar === "extensions" ? (
            <div className="space-y-2 p-3 text-xs text-[#cccccc]">
              <p className="font-medium">Cr8or AI Toolkit</p>
              <p className="text-[#9f9f9f]">Enabled features:</p>
              <p className="text-[#9f9f9f]">- Parallel orchestration</p>
              <p className="text-[#9f9f9f]">- Live agent telemetry</p>
              <p className="text-[#9f9f9f]">- Chat-driven delegation</p>
            </div>
          ) : null}
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
              onClick={() => void runOrchestration(prompt, "manual")}
            >
              {isRunning ? <StopCircle className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {isRunning ? "Stop" : "Delegate via Cr8or AI"}
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
              <div className="flex items-center gap-2">
                <button type="button" className="vscode-mode-tab active" onClick={() => setTimeout(() => chatInputRef.current?.focus(), 0)}>
                  <MessageSquare className="h-3 w-3" />
                  Cr8or AI Lead Console
                </button>
              </div>
              {isRunning ? <Loader2 className="h-3 w-3 animate-spin text-[#858585]" /> : null}
            </div>

            <section className="vscode-chatspace">
              <div className="vscode-chat-header">
                <p className="text-[11px] text-[#9f9f9f]">Chat with Cr8or AI (Software Engineering Lead)</p>
                <p className="text-[10px] text-[#6b6b6b]">Each message auto-delegates a run to specialist agents</p>
              </div>

              <div ref={chatScrollRef} className="vscode-chat-log">
                {chatMessages.map((entry) => (
                  <div key={entry.id} className={`vscode-chat-row ${entry.role === "user" ? "is-user" : "is-assistant"}`}>
                    <div className="vscode-chat-bubble">
                      <p className="mb-1 text-[10px] uppercase tracking-wide text-[#7f7f7f]">
                        {entry.role === "user" ? "You" : "Cr8or AI"}
                      </p>
                      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[#d4d4d4]">{entry.content}</p>
                    </div>
                  </div>
                ))}
                {isChatting ? (
                  <div className="vscode-chat-row is-assistant">
                    <div className="vscode-chat-bubble">
                      <p className="text-[12px] text-[#9f9f9f]">Cr8or AI is planning delegation…</p>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="vscode-chat-input-wrap">
                <textarea
                  ref={chatInputRef}
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendChat();
                    }
                  }}
                  rows={3}
                  className="vscode-chat-input"
                  placeholder="Tell Cr8or AI what to build, improve, or debug..."
                />
                <div className="vscode-chat-actions">
                  <button
                    type="button"
                    className="vscode-ghost-btn"
                    onClick={() => setChatMessages((prev) => prev.slice(0, 1))}
                    disabled={isChatting || chatMessages.length <= 1}
                  >
                    Clear
                  </button>
                  <Button
                    className="h-7 gap-1.5 rounded-sm border border-[#3c3c3c] bg-[#0e639c] px-3 text-xs text-white hover:bg-[#1177bb]"
                    onClick={() => void sendChat()}
                    disabled={isChatting || isRunning || chatInput.trim().length === 0}
                  >
                    {(isChatting || isRunning) ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Send + Delegate
                  </Button>
                </div>
              </div>
            </section>
            {error ? <p className="px-3 py-2 text-xs text-[#f48771]">{error}</p> : null}
          </section>

          {showRightPane ? (
            <aside className="vscode-rightpane">
              <div className="vscode-panel-header">LIVE AGENTS</div>
              <div className="space-y-2 p-3">
                {agentList.length === 0 ? (
                  <p className="text-xs text-[#6b6b6b]">Send a request to Cr8or AI to start delegated execution.</p>
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
                <div className="space-y-2">
                  <pre className="vscode-terminal-log font-mono text-[11px] text-[#cccccc]">
                    {terminalEntries.map((entry) => entry.text).join("\n")}
                  </pre>
                  <div className="vscode-terminal-input-wrap">
                    <input
                      value={terminalCommand}
                      onChange={(event) => setTerminalCommand(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          runTerminalCommand();
                        }
                      }}
                      placeholder="run | stop | status | clear | chat <message>"
                      className="vscode-terminal-input"
                    />
                    <Button className="h-7 px-3 text-xs" onClick={runTerminalCommand}>Execute</Button>
                  </div>
                </div>
              ) : null}
              {activeBottomTab === "problems" ? (
                <div className="text-[11px] text-[#cccccc]">
                  {error ? <p className="text-[#f48771]">1 error: {error}</p> : <p>No problems have been detected.</p>}
                </div>
              ) : null}
              {activeBottomTab === "output" ? (
                <div className="space-y-1 text-[11px] text-[#cccccc]">
                  {timeline.length === 0 ? <p>No output yet.</p> : timeline.map((task) => <p key={task.id}>[{task.agentId}] {task.status}</p>)}
                  {synthesis ? (
                    <p className="pt-2 text-[#9f9f9f]">Synthesis ready: requirements {synthesis.requirements.length}, architecture {synthesis.architecture.length}, quality {synthesis.quality.length}</p>
                  ) : null}
                </div>
              ) : null}
              {activeBottomTab === "debug" ? (
                <pre className="font-mono text-[11px] text-[#cccccc]">
                  {JSON.stringify({ running, completed, activeTabId, chatMessages: chatMessages.length, terminalEntries: terminalEntries.length }, null, 2)}
                </pre>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="vscode-statusbar">
          <div className="flex items-center gap-2">
            <SquareTerminal className="h-3 w-3" />
            <span>Cr8or AI</span>
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
