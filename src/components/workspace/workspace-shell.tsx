"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Bug,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
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
import hljs from "highlight.js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

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
type DelegationPolicy = "auto" | "ask" | "chat-only";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  suggestions?: string[];
  createdAt: number;
};

type TerminalEntry = {
  id: string;
  text: string;
};

type RunStatus = "running" | "completed" | "failed" | "cancelled";

type RunHistoryItem = {
  id: string;
  prompt: string;
  source: "manual" | "chat";
  status: RunStatus;
  startedAt: number;
  durationMs: number;
  completedAgents: number;
  totalAgents: number;
  confidence: number;
  riskCount: number;
  estimatedCostUsd: number;
};

type PendingDelegation = {
  prompt: string;
  response: string;
};

type ChatAttachment = {
  name: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
};

type CommandItem = {
  id: string;
  label: string;
  keywords: string[];
  hint?: string;
  run: () => void;
};

type LeadInsights = {
  confidence: number;
  risks: string[];
  estimatedCostUsd: number;
  latencyMs: number;
};

type ProjectRef = {
  name: string;
  path: string;
  updatedAt?: string;
};

type GitChange = {
  path: string;
  status: string;
};

type GitSnapshot = {
  branch: string;
  changedCount: number;
  changedFiles: GitChange[];
  remotes: string;
  tracking: string;
  recentCommits: string;
  updatedAt: number;
};

type GithubRepoSummary = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
};

type GithubBranchSummary = {
  name: string;
  sha: string;
};

type GithubContentItem = {
  type: string;
  name: string;
  path: string;
  sha: string;
};

type PolicyProfile = "strict" | "balanced" | "autonomous";

type RiskAction =
  | "files.write"
  | "git.commit-push"
  | "github.write"
  | "deploy.vercel"
  | "project.create"
  | "project.clone";

type ApprovalRecord = {
  id: string;
  action: RiskAction;
  title: string;
  preview: string;
  requestedBy: string;
  requestedRole: string;
  requestedAt: string;
  status: "pending" | "approved" | "denied";
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  expiresAt: string;
  consumedAt?: string;
};

type SecretReadiness = {
  provider: string;
  checks: {
    ai: boolean;
    openai: boolean;
    anthropic: boolean;
    deepseek: boolean;
    github: boolean;
    vercel: boolean;
    supabase: boolean;
  };
  missing: {
    ai: string[];
    github: string[];
    vercel: string[];
    supabase: string[];
  };
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

const PERSISTENCE_KEY = "cr8or-studio.workspace.v3";
const ONBOARDING_KEY = "cr8or-studio.onboarding.completed.v1";
const MAX_TIMELINE_RENDER = 30;
const MAX_OUTPUT_RENDER = 40;
const MAX_TERMINAL_ENTRIES_RENDER = 240;
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];
const RISK_TERMS = ["risk", "blocker", "uncertain", "unknown", "security", "failure", "todo", "gap"];
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "xml",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  prisma: "prisma",
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

function getFileExtension(filePath: string): string {
  const parts = filePath.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function summarizeLeadInsights(timeline: AgentTask[], startedAt: number, endedAt: number): LeadInsights {
  if (timeline.length === 0) {
    return { confidence: 0, risks: [], estimatedCostUsd: 0, latencyMs: Math.max(endedAt - startedAt, 0) };
  }

  const completed = timeline.filter((task) => task.status === "completed").length;
  const lowerOutput = timeline.map((task) => (task.output ?? "").toLowerCase()).join("\n");
  const risks = RISK_TERMS.filter((term) => lowerOutput.includes(term));
  const confidence = Math.max(28, Math.min(95, Math.round((completed / timeline.length) * 100 - risks.length * 6)));
  const estimatedTokens = Math.ceil(
    timeline.reduce((sum, task) => sum + (task.output?.length ?? 0), 0) / 4,
  );
  const estimatedCostUsd = Number((estimatedTokens * 0.0000012).toFixed(4));

  return {
    confidence,
    risks: risks.map((risk) => `Potential ${risk} concerns flagged in agent output.`),
    estimatedCostUsd,
    latencyMs: Math.max(endedAt - startedAt, 0),
  };
}

export function WorkspaceShell() {
  const [prompt, setPrompt] = useState(SEED_PROMPT);
  const [delegationPolicy, setDelegationPolicy] = useState<DelegationPolicy>("auto");
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
    { id: "README.md", title: "README.md" },
    { id: "src/components/workspace/workspace-shell.tsx", title: "workspace-shell.tsx", dirty: true },
  ]);
  const [activeTabId, setActiveTabId] = useState("cr8or-ai.chat");
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteRecentIds, setPaletteRecentIds] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [isChatting, setIsChatting] = useState(false);
  const [pendingDelegation, setPendingDelegation] = useState<PendingDelegation | null>(null);
  const [pendingPromptDraft, setPendingPromptDraft] = useState("");
  const [leadInsights, setLeadInsights] = useState<LeadInsights>({
    confidence: 0,
    risks: [],
    estimatedCostUsd: 0,
    latencyMs: 0,
  });
  const [runHistory, setRunHistory] = useState<RunHistoryItem[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectRef>({ name: "Cr8or-Studio", path: "." });
  const [recentProjects, setRecentProjects] = useState<ProjectRef[]>([]);
  const [gitSnapshot, setGitSnapshot] = useState<GitSnapshot | null>(null);
  const [selectedDiffPath, setSelectedDiffPath] = useState("");
  const [diffPreview, setDiffPreview] = useState("");
  const [stagedDiffPreview, setStagedDiffPreview] = useState("");
  const [isDiffBusy, setIsDiffBusy] = useState(false);
  const [githubRepos, setGithubRepos] = useState<GithubRepoSummary[]>([]);
  const [githubBranches, setGithubBranches] = useState<GithubBranchSummary[]>([]);
  const [githubContents, setGithubContents] = useState<GithubContentItem[]>([]);
  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("");
  const [githubPath, setGithubPath] = useState("");
  const [githubFileSha, setGithubFileSha] = useState("");
  const [githubFileContent, setGithubFileContent] = useState("");
  const [githubCommitMsg, setGithubCommitMsg] = useState("chore: update file via Cr8or Studio API");
  const [githubNewBranch, setGithubNewBranch] = useState("");
  const [githubPrTitle, setGithubPrTitle] = useState("");
  const [githubPrBody, setGithubPrBody] = useState("");
  const [githubBaseBranch, setGithubBaseBranch] = useState("");
  const [githubHeadBranch, setGithubHeadBranch] = useState("");
  const [githubPrNumber, setGithubPrNumber] = useState("");
  const [githubApiStatus, setGithubApiStatus] = useState("");
  const [githubChecksSummary, setGithubChecksSummary] = useState("");
  const [isGithubApiBusy, setIsGithubApiBusy] = useState(false);
  const [secretReadiness, setSecretReadiness] = useState<SecretReadiness | null>(null);
  const [secretReadinessStatus, setSecretReadinessStatus] = useState("");
  const [isSecretReadinessBusy, setIsSecretReadinessBusy] = useState(false);
  const [policyProfile, setPolicyProfile] = useState<PolicyProfile>("balanced");
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [isApprovalsBusy, setIsApprovalsBusy] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState("");
  const [approvedActionIds, setApprovedActionIds] = useState<Partial<Record<RiskAction, string>>>({});
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [projectPathInput, setProjectPathInput] = useState("projects/");
  const [repositoryInput, setRepositoryInput] = useState("");
  const [gitCommitMessage, setGitCommitMessage] = useState("chore: update project via Cr8or Studio");
  const [isProjectBusy, setIsProjectBusy] = useState(false);
  const [isGitBusy, setIsGitBusy] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [fileContentByPath, setFileContentByPath] = useState<Record<string, string>>({});
  const [fileErrorByPath, setFileErrorByPath] = useState<Record<string, string>>({});
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);
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
  const chatFileInputRef = useRef<HTMLInputElement | null>(null);
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
      setPaletteIndex(0);
    }
  }, [isPaletteOpen]);

  useEffect(() => {
    if (!chatScrollRef.current) return;
    chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages]);

  useEffect(() => {
    try {
      const done = localStorage.getItem(ONBOARDING_KEY);
      if (!done) {
        setIsOnboardingOpen(true);
      }
    } catch {
      setIsOnboardingOpen(true);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERSISTENCE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Partial<{
        prompt: string;
        delegationPolicy: DelegationPolicy;
        chatMessages: ChatMessage[];
        openTabs: EditorTab[];
        activeTabId: string;
        terminalEntries: TerminalEntry[];
        runHistory: RunHistoryItem[];
        showExplorer: boolean;
        showRightPane: boolean;
        showBottomPanel: boolean;
        activeSidebar: SidebarView;
        currentProject: ProjectRef;
        recentProjects: ProjectRef[];
        gitSnapshot: GitSnapshot;
      }>;

      if (typeof data.prompt === "string") setPrompt(data.prompt);
      if (data.delegationPolicy) setDelegationPolicy(data.delegationPolicy);
      if (Array.isArray(data.chatMessages) && data.chatMessages.length > 0) setChatMessages(data.chatMessages);
      if (Array.isArray(data.openTabs) && data.openTabs.length > 0) setOpenTabs(data.openTabs);
      if (typeof data.activeTabId === "string") setActiveTabId(data.activeTabId);
      if (Array.isArray(data.terminalEntries) && data.terminalEntries.length > 0) setTerminalEntries(data.terminalEntries);
      if (Array.isArray(data.runHistory)) setRunHistory(data.runHistory.slice(0, 30));
      if (typeof data.showExplorer === "boolean") setShowExplorer(data.showExplorer);
      if (typeof data.showRightPane === "boolean") setShowRightPane(data.showRightPane);
      if (typeof data.showBottomPanel === "boolean") setShowBottomPanel(data.showBottomPanel);
      if (data.activeSidebar) setActiveSidebar(data.activeSidebar);
      if (data.currentProject) setCurrentProject(data.currentProject);
      if (Array.isArray(data.recentProjects)) setRecentProjects(data.recentProjects.slice(0, 20));
      if (data.gitSnapshot) setGitSnapshot(data.gitSnapshot);
    } catch {
      // ignore invalid persisted data
    }
  }, []);

  useEffect(() => {
    const payload = {
      prompt,
      delegationPolicy,
      chatMessages,
      openTabs,
      activeTabId,
      terminalEntries,
      runHistory,
      showExplorer,
      showRightPane,
      showBottomPanel,
      activeSidebar,
      currentProject,
      recentProjects,
      gitSnapshot,
    };
    localStorage.setItem(PERSISTENCE_KEY, JSON.stringify(payload));
  }, [
    activeSidebar,
    activeTabId,
    chatMessages,
    delegationPolicy,
    openTabs,
    prompt,
    runHistory,
    showBottomPanel,
    showExplorer,
    showRightPane,
    terminalEntries,
    currentProject,
    recentProjects,
    gitSnapshot,
  ]);

  const pushChatMessage = useCallback((role: ChatRole, content: string) => {
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        role,
        content,
        suggestions: [],
        createdAt: Date.now(),
      },
    ]);
  }, []);

  const loadFileContent = useCallback(async (filePath: string) => {
    if (filePath === "cr8or-ai.chat") return;
    if (fileContentByPath[filePath]) return;

    setLoadingFilePath(filePath);
    setFileErrorByPath((prev) => ({ ...prev, [filePath]: "" }));
    try {
      const response = await fetch(`/api/files?path=${encodeURIComponent(filePath)}`);
      const payload = (await response.json()) as { content?: string; message?: string };
      if (!response.ok) {
        throw new Error(payload.message || `Unable to open ${filePath}`);
      }
      setFileContentByPath((prev) => ({ ...prev, [filePath]: payload.content ?? "" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open file.";
      if (message.includes("Local workspace files are unavailable in the deployed app")) {
        setOpenTabs((prev) => prev.filter((tab) => tab.id === "cr8or-ai.chat"));
        setActiveTabId("cr8or-ai.chat");
      }
      setFileErrorByPath((prev) => ({ ...prev, [filePath]: message }));
    } finally {
      setLoadingFilePath((current) => (current === filePath ? null : current));
    }
  }, [fileContentByPath]);

  useEffect(() => {
    if (activeTabId === "cr8or-ai.chat") return;
    void loadFileContent(activeTabId);
  }, [activeTabId, loadFileContent]);

  const loadRecentProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recent" }),
      });
      if (!response.ok) return;
      const data = (await response.json()) as { projects?: ProjectRef[] };
      if (Array.isArray(data.projects)) {
        setRecentProjects(data.projects.slice(0, 20));
      }
    } catch {
      // no-op
    }
  }, []);

  const loadPolicyProfile = useCallback(async () => {
    try {
      const response = await fetch("/api/security/policy", { method: "GET" });
      if (!response.ok) return;
      const data = (await response.json()) as { profile?: PolicyProfile };
      if (data.profile) {
        setPolicyProfile(data.profile);
      }
    } catch {
      // no-op
    }
  }, []);

  const updatePolicyProfile = useCallback(async (profile: PolicyProfile) => {
    setIsApprovalsBusy(true);
    try {
      const response = await fetch("/api/security/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      const data = (await response.json()) as { message?: string; profile?: PolicyProfile };
      if (!response.ok || !data.profile) {
        throw new Error(data.message || "Failed to update policy profile.");
      }
      setPolicyProfile(data.profile);
      setApprovalStatus(`Policy profile set to ${data.profile}.`);
    } catch (err) {
      setApprovalStatus(err instanceof Error ? err.message : "Failed to update policy profile.");
    } finally {
      setIsApprovalsBusy(false);
    }
  }, []);

  const loadApprovals = useCallback(async () => {
    setIsApprovalsBusy(true);
    try {
      const response = await fetch("/api/security/approvals?limit=50", { method: "GET" });
      const data = (await response.json()) as { approvals?: ApprovalRecord[]; message?: string };
      if (!response.ok) {
        throw new Error(data.message || "Failed to load approvals.");
      }
      setApprovals(data.approvals ?? []);
    } catch (err) {
      setApprovalStatus(err instanceof Error ? err.message : "Failed to load approvals.");
    } finally {
      setIsApprovalsBusy(false);
    }
  }, []);

  const requestApproval = useCallback(async (action: RiskAction, title: string, preview: unknown) => {
    const previewText = typeof preview === "string" ? preview : JSON.stringify(preview, null, 2);
    const response = await fetch("/api/security/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "request",
        payload: {
          action,
          title,
          preview: previewText,
        },
      }),
    });

    const data = (await response.json()) as { message?: string; approval?: ApprovalRecord };
    if (!response.ok || !data.approval) {
      throw new Error(data.message || "Approval request failed.");
    }

    setApprovalStatus(`Approval requested: ${data.approval.id.slice(0, 8)} for ${action}`);
    setApprovals((prev) => [data.approval as ApprovalRecord, ...prev]);
    return data.approval;
  }, []);

  const decideApproval = useCallback(async (record: ApprovalRecord, decision: "approved" | "denied") => {
    setIsApprovalsBusy(true);
    try {
      const response = await fetch("/api/security/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "decide",
          payload: {
            id: record.id,
            decision,
          },
        }),
      });
      const data = (await response.json()) as { message?: string; approval?: ApprovalRecord };
      if (!response.ok || !data.approval) {
        throw new Error(data.message || "Failed to submit approval decision.");
      }

      setApprovals((prev) => prev.map((item) => (item.id === data.approval!.id ? data.approval! : item)));
      if (decision === "approved") {
        setApprovedActionIds((prev) => ({
          ...prev,
          [data.approval!.action]: data.approval!.id,
        }));
      }
      setApprovalStatus(`${decision === "approved" ? "Approved" : "Denied"} ${record.action}.`);
    } catch (err) {
      setApprovalStatus(err instanceof Error ? err.message : "Failed to submit approval decision.");
    } finally {
      setIsApprovalsBusy(false);
    }
  }, []);

  const handleApprovalConflict = useCallback(async (action: RiskAction, title: string, payload: Record<string, unknown>) => {
    if (!payload.requiresApproval) {
      throw new Error((payload.message as string) || "Operation blocked.");
    }
    const approval = await requestApproval(action, title, payload.preview ?? payload);
    await loadApprovals();
    appendTerminal(`approval requested for ${action}: ${approval.id}`);
  }, [appendTerminal, loadApprovals, requestApproval]);

  useEffect(() => {
    void loadRecentProjects();
  }, [loadRecentProjects]);

  const createProject = useCallback(async (nameOverride?: string) => {
    const name = (nameOverride ?? projectNameInput).trim();
    if (!name) return;
    setIsProjectBusy(true);
    try {
      const response = await fetch("/api/projects/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name,
          approvalId: approvedActionIds["project.create"],
        }),
      });
      const data = (await response.json()) as { project?: ProjectRef & { files?: Array<{ name: string; type: string }> }; message?: string; requiresApproval?: boolean; preview?: unknown };
      if (!response.ok) {
        if (response.status === 409) {
          await handleApprovalConflict("project.create", `Create project ${name}`, data as unknown as Record<string, unknown>);
          return;
        }
        throw new Error(data.message || "Unable to create project.");
      }
      if (data.project) {
        setCurrentProject({ name: data.project.name, path: data.project.path });
        appendTerminal(`Project created: ${data.project.path}`);
        setApprovedActionIds((prev) => ({ ...prev, "project.create": undefined }));
      }
      setProjectNameInput("");
      await loadRecentProjects();
    } catch (err) {
      appendTerminal(`project error: ${err instanceof Error ? err.message : "create failed"}`);
    } finally {
      setIsProjectBusy(false);
    }
  }, [appendTerminal, approvedActionIds, handleApprovalConflict, loadRecentProjects, projectNameInput]);

  const openProjectByPath = useCallback(async (projectPath: string) => {
    const value = projectPath.trim();
    if (!value) return;
    setIsProjectBusy(true);
    try {
      const response = await fetch("/api/projects/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", path: value }),
      });
      if (!response.ok) throw new Error("Unable to open project.");
      const data = (await response.json()) as { project?: ProjectRef & { files?: Array<{ name: string; type: string }> } };
      if (data.project) {
        setCurrentProject({ name: data.project.name, path: data.project.path });
        appendTerminal(`Project opened: ${data.project.path}`);
        const file = data.project.files?.find((item) => item.type === "file");
        if (file) {
          const relative = `${data.project.path}/${file.name}`;
          const title = relative.split("/").pop() || relative;
          setOpenTabs((prev) => {
            if (prev.some((tab) => tab.id === relative)) {
              return prev;
            }
            return [...prev, { id: relative, title }];
          });
          setActiveTabId(relative);
          void loadFileContent(relative);
        }
      }
      await loadRecentProjects();
    } catch (err) {
      appendTerminal(`project error: ${err instanceof Error ? err.message : "open failed"}`);
    } finally {
      setIsProjectBusy(false);
    }
  }, [appendTerminal, loadFileContent, loadRecentProjects]);

  const cloneGithubProject = useCallback(async (repositoryUrlOverride?: string) => {
    const repositoryUrl = (repositoryUrlOverride ?? repositoryInput).trim();
    if (!repositoryUrl) return;
    setIsProjectBusy(true);
    try {
      const response = await fetch("/api/projects/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clone",
          repositoryUrl,
          approvalId: approvedActionIds["project.clone"],
        }),
      });
      const data = (await response.json()) as { project?: ProjectRef; message?: string; requiresApproval?: boolean; preview?: unknown };
      if (!response.ok) {
        if (response.status === 409) {
          await handleApprovalConflict("project.clone", `Clone project ${repositoryUrl}`, data as unknown as Record<string, unknown>);
          return;
        }
        throw new Error(data.message || "Clone failed.");
      }
      if (data.project) {
        setCurrentProject({ name: data.project.name, path: data.project.path });
        appendTerminal(`GitHub project cloned: ${data.project.path}`);
        setApprovedActionIds((prev) => ({ ...prev, "project.clone": undefined }));
      }
      setRepositoryInput("");
      await loadRecentProjects();
    } catch (err) {
      appendTerminal(`clone error: ${err instanceof Error ? err.message : "clone failed"}`);
    } finally {
      setIsProjectBusy(false);
    }
  }, [appendTerminal, approvedActionIds, handleApprovalConflict, loadRecentProjects, repositoryInput]);

  const runGitStatus = useCallback(async () => {
    setIsGitBusy(true);
    try {
      const response = await fetch("/api/github/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", projectPath: currentProject.path }),
      });
      if (!response.ok) throw new Error("Git status failed.");
      const data = (await response.json()) as {
        branch?: string;
        changes?: string;
        remotes?: string;
        tracking?: string;
        recentCommits?: string;
        changedCount?: number;
        changedFiles?: GitChange[];
      };

      setGitSnapshot({
        branch: data.branch ?? "unknown",
        changedCount: data.changedCount ?? 0,
        changedFiles: data.changedFiles ?? [],
        remotes: data.remotes ?? "",
        tracking: data.tracking ?? "",
        recentCommits: data.recentCommits ?? "",
        updatedAt: Date.now(),
      });

      appendTerminal(`git branch: ${data.branch ?? "unknown"}`);
      appendTerminal(data.changes || "no local changes");
      if (data.remotes) appendTerminal(data.remotes);
    } catch (err) {
      appendTerminal(`git error: ${err instanceof Error ? err.message : "status failed"}`);
    } finally {
      setIsGitBusy(false);
    }
  }, [appendTerminal, currentProject.path]);

  const runCommitPush = useCallback(async () => {
    setIsGitBusy(true);
    try {
      const response = await fetch("/api/github/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commit-push",
          projectPath: currentProject.path,
          message: gitCommitMessage,
          approvalId: approvedActionIds["git.commit-push"],
        }),
      });
      const data = (await response.json()) as { commit?: string; push?: string; message?: string; requiresApproval?: boolean; preview?: unknown };
      if (!response.ok) {
        if (response.status === 409) {
          await handleApprovalConflict("git.commit-push", "Commit and push current project", data as unknown as Record<string, unknown>);
          setStatusLine("Approval requested for git push.");
          return;
        }
        throw new Error(data.message || "Commit/push failed.");
      }
      if (data.commit) appendTerminal(data.commit);
      if (data.push) appendTerminal(data.push);
      setStatusLine("Git commit/push completed.");
      setApprovedActionIds((prev) => ({ ...prev, "git.commit-push": undefined }));
    } catch (err) {
      appendTerminal(`git error: ${err instanceof Error ? err.message : "commit/push failed"}`);
      setStatusLine("Git operation failed.");
    } finally {
      setIsGitBusy(false);
    }
  }, [appendTerminal, approvedActionIds, currentProject.path, gitCommitMessage, handleApprovalConflict]);

  const loadDiffPreview = useCallback(async (filePath: string) => {
    if (!filePath) return;
    setIsDiffBusy(true);
    try {
      const response = await fetch("/api/github/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "diff",
          projectPath: currentProject.path,
          filePath,
        }),
      });
      const data = (await response.json()) as { message?: string; diff?: string; stagedDiff?: string };
      if (!response.ok) {
        throw new Error(data.message || "Failed to load diff preview.");
      }
      setSelectedDiffPath(filePath);
      setDiffPreview(data.diff || "");
      setStagedDiffPreview(data.stagedDiff || "");
    } catch (err) {
      appendTerminal(`diff error: ${err instanceof Error ? err.message : "preview failed"}`);
    } finally {
      setIsDiffBusy(false);
    }
  }, [appendTerminal, currentProject.path]);

  const stageFile = useCallback(async (filePath: string, action: "stage" | "unstage") => {
    setIsDiffBusy(true);
    try {
      const response = await fetch("/api/github/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          projectPath: currentProject.path,
          filePath,
          approvalId: approvedActionIds["files.write"],
        }),
      });
      const data = (await response.json()) as { message?: string; requiresApproval?: boolean; preview?: unknown; output?: string };
      if (!response.ok) {
        if (response.status === 409) {
          await handleApprovalConflict(
            "files.write",
            `${action === "stage" ? "Stage" : "Unstage"} ${filePath}`,
            data as unknown as Record<string, unknown>,
          );
          return;
        }
        throw new Error(data.message || `${action} failed`);
      }

      if (data.output) appendTerminal(data.output);
      setApprovedActionIds((prev) => ({ ...prev, "files.write": undefined }));
      await runGitStatus();
      await loadDiffPreview(filePath);
    } catch (err) {
      appendTerminal(`git ${action} error: ${err instanceof Error ? err.message : "action failed"}`);
    } finally {
      setIsDiffBusy(false);
    }
  }, [appendTerminal, approvedActionIds, currentProject.path, handleApprovalConflict, loadDiffPreview, runGitStatus]);

  const previewCommitPush = useCallback(async () => {
    setIsGitBusy(true);
    try {
      const response = await fetch("/api/github/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commit-push",
          projectPath: currentProject.path,
          message: gitCommitMessage,
          dryRun: true,
        }),
      });
      const data = (await response.json()) as { preview?: unknown; message?: string };
      if (!response.ok) {
        throw new Error(data.message || "Failed to preview commit/push.");
      }
      appendTerminal(`dry-run git.commit-push:\n${JSON.stringify(data.preview ?? {}, null, 2)}`);
    } catch (err) {
      appendTerminal(`git preview error: ${err instanceof Error ? err.message : "preview failed"}`);
    } finally {
      setIsGitBusy(false);
    }
  }, [appendTerminal, currentProject.path, gitCommitMessage]);

  const runDeploy = useCallback(async () => {
    setIsGitBusy(true);
    try {
      const response = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: currentProject.path,
          strategy: "vercel",
          approvalId: approvedActionIds["deploy.vercel"],
        }),
      });
      const data = (await response.json()) as { logs?: string; message?: string; requiresApproval?: boolean; preview?: unknown };
      if (!response.ok) {
        if (response.status === 409) {
          await handleApprovalConflict("deploy.vercel", "Deploy current project to Vercel", data as unknown as Record<string, unknown>);
          setStatusLine("Approval requested for deploy.");
          return;
        }
        throw new Error(data.message || "Deploy failed.");
      }
      appendTerminal(data.logs || "Deploy finished.");
      setStatusLine("Deploy completed.");
      setApprovedActionIds((prev) => ({ ...prev, "deploy.vercel": undefined }));
    } catch (err) {
      appendTerminal(`deploy error: ${err instanceof Error ? err.message : "deploy failed"}`);
      setStatusLine("Deploy failed.");
    } finally {
      setIsGitBusy(false);
    }
  }, [appendTerminal, approvedActionIds, currentProject.path, handleApprovalConflict]);

  const previewDeploy = useCallback(async () => {
    setIsGitBusy(true);
    try {
      const response = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: currentProject.path,
          strategy: "vercel",
          dryRun: true,
        }),
      });
      const data = (await response.json()) as { preview?: unknown; message?: string };
      if (!response.ok) {
        throw new Error(data.message || "Failed to preview deploy.");
      }
      appendTerminal(`dry-run deploy.vercel:\n${JSON.stringify(data.preview ?? {}, null, 2)}`);
    } catch (err) {
      appendTerminal(`deploy preview error: ${err instanceof Error ? err.message : "preview failed"}`);
    } finally {
      setIsGitBusy(false);
    }
  }, [appendTerminal, currentProject.path]);

  const callGithubApi = useCallback(async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/github/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const error = new Error((data.message as string) || `GitHub API error ${response.status}`) as Error & {
        status?: number;
        payload?: Record<string, unknown>;
      };
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }, []);

  const loadGithubRepos = useCallback(async () => {
    setIsGithubApiBusy(true);
    try {
      const data = await callGithubApi({ action: "list-repos" }) as { repos?: GithubRepoSummary[] };
      const repos = data.repos ?? [];
      setGithubRepos(repos);
      setGithubApiStatus(`Loaded ${repos.length} repositories.`);
      appendTerminal(`github api: loaded ${repos.length} repositories`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load repositories.";
      setGithubApiStatus(message);
      appendTerminal(`github api error: ${message}`);
    } finally {
      setIsGithubApiBusy(false);
    }
  }, [appendTerminal, callGithubApi]);

  const loadGithubBranches = useCallback(async (ownerArg?: string, repoArg?: string) => {
    const owner = (ownerArg ?? githubOwner).trim();
    const repo = (repoArg ?? githubRepo).trim();
    if (!owner || !repo) return;

    setIsGithubApiBusy(true);
    try {
      const data = await callGithubApi({ action: "list-branches", owner, repo }) as {
        defaultBranch?: string;
        branches?: GithubBranchSummary[];
      };
      const branches = data.branches ?? [];
      const defaultBranch = data.defaultBranch ?? branches[0]?.name ?? "";
      setGithubBranches(branches);
      setGithubBaseBranch(defaultBranch);
      setGithubBranch((prev) => prev || defaultBranch);
      setGithubHeadBranch((prev) => prev || defaultBranch);
      setGithubApiStatus(`Loaded ${branches.length} branches for ${owner}/${repo}.`);
      appendTerminal(`github api: loaded branches for ${owner}/${repo}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load branches.";
      setGithubApiStatus(message);
      appendTerminal(`github api error: ${message}`);
    } finally {
      setIsGithubApiBusy(false);
    }
  }, [appendTerminal, callGithubApi, githubOwner, githubRepo]);

  const loadGithubContents = useCallback(async (pathArg?: string) => {
    const owner = githubOwner.trim();
    const repo = githubRepo.trim();
    if (!owner || !repo) return;

    setIsGithubApiBusy(true);
    try {
      const data = await callGithubApi({
        action: "list-contents",
        owner,
        repo,
        path: (pathArg ?? githubPath).trim(),
        ref: githubBranch.trim() || undefined,
      }) as { items?: GithubContentItem[] };
      setGithubContents(data.items ?? []);
      setGithubApiStatus(`Loaded ${data.items?.length ?? 0} items.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load repository contents.";
      setGithubApiStatus(message);
      appendTerminal(`github api error: ${message}`);
    } finally {
      setIsGithubApiBusy(false);
    }
  }, [appendTerminal, callGithubApi, githubBranch, githubOwner, githubPath, githubRepo]);

  const readGithubFile = useCallback(async (pathArg?: string) => {
    const owner = githubOwner.trim();
    const repo = githubRepo.trim();
    const pathValue = (pathArg ?? githubPath).trim();
    if (!owner || !repo || !pathValue) return;

    setIsGithubApiBusy(true);
    try {
      const data = await callGithubApi({
        action: "read-file",
        owner,
        repo,
        path: pathValue,
        ref: githubBranch.trim() || undefined,
      }) as { content?: string; sha?: string };
      setGithubPath(pathValue);
      setGithubFileContent(data.content ?? "");
      setGithubFileSha(data.sha ?? "");
      setGithubApiStatus(`Loaded file: ${pathValue}`);
      appendTerminal(`github api: opened ${pathValue}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read file.";
      setGithubApiStatus(message);
      appendTerminal(`github api error: ${message}`);
    } finally {
      setIsGithubApiBusy(false);
    }
  }, [appendTerminal, callGithubApi, githubBranch, githubOwner, githubPath, githubRepo]);

  const saveGithubFile = useCallback(async () => {
    const owner = githubOwner.trim();
    const repo = githubRepo.trim();
    const pathValue = githubPath.trim();
    const branch = githubBranch.trim();
    if (!owner || !repo || !pathValue || !branch) return;

    setIsGithubApiBusy(true);
    try {
      const data = await callGithubApi({
        action: "upsert-file",
        owner,
        repo,
        path: pathValue,
        branch,
        message: githubCommitMsg.trim() || "chore: update file via Cr8or Studio API",
        content: githubFileContent,
        sha: githubFileSha || undefined,
        approvalId: approvedActionIds["github.write"],
      }) as { contentSha?: string; commitSha?: string };
      setGithubFileSha(data.contentSha ?? githubFileSha);
      setGithubApiStatus(`Saved ${pathValue} on ${branch}.`);
      appendTerminal(`github api: committed ${pathValue} (${(data.commitSha ?? "").slice(0, 7)})`);
      setApprovedActionIds((prev) => ({ ...prev, "github.write": undefined }));
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status?: number }).status === 409 &&
        "payload" in err
      ) {
        const payload = ((err as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>;
        await handleApprovalConflict("github.write", `Save ${pathValue} on ${branch}`, payload);
        setGithubApiStatus("Approval requested for GitHub write.");
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to save file.";
      setGithubApiStatus(message);
      appendTerminal(`github api error: ${message}`);
    } finally {
      setIsGithubApiBusy(false);
    }
  }, [appendTerminal, approvedActionIds, callGithubApi, githubBranch, githubCommitMsg, githubFileContent, githubFileSha, githubOwner, githubPath, githubRepo, handleApprovalConflict]);

  const createGithubBranch = useCallback(async () => {
    const owner = githubOwner.trim();
    const repo = githubRepo.trim();
    const fromBranch = githubBaseBranch.trim();
    const newBranch = githubNewBranch.trim();
    if (!owner || !repo || !fromBranch || !newBranch) return;

    setIsGithubApiBusy(true);
    try {
      await callGithubApi({ action: "create-branch", owner, repo, fromBranch, newBranch, approvalId: approvedActionIds["github.write"] });
      setGithubBranch(newBranch);
      setGithubHeadBranch(newBranch);
      setGithubApiStatus(`Created branch ${newBranch} from ${fromBranch}.`);
      appendTerminal(`github api: created branch ${newBranch}`);
      await loadGithubBranches(owner, repo);
      setApprovedActionIds((prev) => ({ ...prev, "github.write": undefined }));
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status?: number }).status === 409 &&
        "payload" in err
      ) {
        const payload = ((err as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>;
        await handleApprovalConflict("github.write", `Create branch ${newBranch} from ${fromBranch}`, payload);
        setGithubApiStatus("Approval requested for GitHub branch creation.");
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to create branch.";
      setGithubApiStatus(message);
      appendTerminal(`github api error: ${message}`);
    } finally {
      setIsGithubApiBusy(false);
    }
  }, [appendTerminal, approvedActionIds, callGithubApi, githubBaseBranch, githubNewBranch, githubOwner, githubRepo, handleApprovalConflict, loadGithubBranches]);

  const createGithubPr = useCallback(async () => {
    const owner = githubOwner.trim();
    const repo = githubRepo.trim();
    const title = githubPrTitle.trim();
    const head = githubHeadBranch.trim();
    const base = githubBaseBranch.trim();
    if (!owner || !repo || !title || !head || !base) return;

    setIsGithubApiBusy(true);
    try {
      const data = await callGithubApi({
        action: "create-pr",
        owner,
        repo,
        title,
        body: githubPrBody,
        head,
        base,
        approvalId: approvedActionIds["github.write"],
      }) as { number?: number; url?: string };
      if (data.number) {
        setGithubPrNumber(String(data.number));
      }
      setGithubApiStatus(`Created PR #${data.number ?? "?"}.`);
      appendTerminal(`github api: created PR ${data.url ?? ""}`);
      setApprovedActionIds((prev) => ({ ...prev, "github.write": undefined }));
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status?: number }).status === 409 &&
        "payload" in err
      ) {
        const payload = ((err as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>;
        await handleApprovalConflict("github.write", `Create PR ${title}`, payload);
        setGithubApiStatus("Approval requested for GitHub PR creation.");
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to create PR.";
      setGithubApiStatus(message);
      appendTerminal(`github api error: ${message}`);
    } finally {
      setIsGithubApiBusy(false);
    }
  }, [appendTerminal, approvedActionIds, callGithubApi, githubBaseBranch, githubHeadBranch, githubOwner, githubPrBody, githubPrTitle, githubRepo, handleApprovalConflict]);

  const loadPrChecks = useCallback(async () => {
    const owner = githubOwner.trim();
    const repo = githubRepo.trim();
    const pullNumber = Number(githubPrNumber);
    if (!owner || !repo || Number.isNaN(pullNumber) || pullNumber <= 0) return;

    setIsGithubApiBusy(true);
    try {
      const data = await callGithubApi({ action: "pr-checks", owner, repo, pullNumber }) as {
        combinedStatus?: string;
        checkRuns?: Array<{ name: string; status: string; conclusion: string | null }>;
      };
      const runs = data.checkRuns ?? [];
      const runSummary = runs.slice(0, 6).map((run) => `${run.name}:${run.conclusion ?? run.status}`).join(" | ");
      const summary = `PR #${pullNumber} checks: ${data.combinedStatus ?? "unknown"}${runSummary ? ` | ${runSummary}` : ""}`;
      setGithubChecksSummary(summary);
      setGithubApiStatus(summary);
      appendTerminal(`github api: ${summary}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load PR checks.";
      setGithubApiStatus(message);
      appendTerminal(`github api error: ${message}`);
    } finally {
      setIsGithubApiBusy(false);
    }
  }, [appendTerminal, callGithubApi, githubOwner, githubPrNumber, githubRepo]);

  const loadSecretReadiness = useCallback(async () => {
    setIsSecretReadinessBusy(true);
    try {
      const response = await fetch("/api/security/readiness", { method: "GET" });
      const data = (await response.json()) as {
        message?: string;
        readiness?: SecretReadiness;
      };
      if (!response.ok || !data.readiness) {
        throw new Error(data.message || "Failed to load secret readiness.");
      }

      const checks = data.readiness.checks;
      const passCount = Object.values(checks).filter(Boolean).length;
      const total = Object.keys(checks).length;
      setSecretReadiness(data.readiness);
      setSecretReadinessStatus(`Secrets readiness ${passCount}/${total} ready.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load secret readiness.";
      setSecretReadinessStatus(message);
      appendTerminal(`security readiness error: ${message}`);
    } finally {
      setIsSecretReadinessBusy(false);
    }
  }, [appendTerminal]);

  useEffect(() => {
    if (activeSidebar !== "source-control") return;
    void runGitStatus();
    void loadSecretReadiness();
    void loadPolicyProfile();
    void loadApprovals();
  }, [activeSidebar, currentProject.path, loadApprovals, loadPolicyProfile, loadSecretReadiness, runGitStatus]);

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
    const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
    const startTime = Date.now();

    setRunHistory((prev) => [
      {
        id: runId,
        prompt: orchestrationPrompt,
        source,
        status: "running" as const,
        startedAt: startTime,
        durationMs: 0,
        completedAgents: 0,
        totalAgents: 0,
        confidence: 0,
        riskCount: 0,
        estimatedCostUsd: 0,
      },
      ...prev,
    ].slice(0, 30));

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
        body: JSON.stringify({
          prompt: orchestrationPrompt,
          projectId: currentProject.path === "." ? "workspace-root" : (currentProject.path || "default-project"),
        }),
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

              const completedAgents = event.result.timeline.filter((task) => task.status === "completed").length;
              const insights = summarizeLeadInsights(event.result.timeline, startTime, Date.now());
              setLeadInsights(insights);
              setRunHistory((prev) =>
                prev.map((item) =>
                  item.id === runId
                    ? {
                        ...item,
                        status: "completed",
                        durationMs: insights.latencyMs,
                        completedAgents,
                        totalAgents: event.result.timeline.length,
                        confidence: insights.confidence,
                        riskCount: insights.risks.length,
                        estimatedCostUsd: insights.estimatedCostUsd,
                      }
                    : item,
                ),
              );
            } else if (event.type === "error") {
              setError(event.message);
              setActiveBottomTab("problems");
              appendTerminal(`error: ${event.message}`);
              const latencyMs = Math.max(Date.now() - startTime, 0);
              setRunHistory((prev) =>
                prev.map((item) =>
                  item.id === runId
                    ? {
                        ...item,
                        status: "failed",
                        durationMs: latencyMs,
                      }
                    : item,
                ),
              );
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      const latencyMs = Math.max(Date.now() - startTime, 0);
      if ((err as Error).name !== "AbortError") {
        const message = err instanceof Error ? err.message : "Unknown error.";
        setError(message);
        setActiveBottomTab("problems");
        appendTerminal(`error: ${message}`);
        setRunHistory((prev) =>
          prev.map((item) =>
            item.id === runId
              ? {
                  ...item,
                  status: "failed",
                  durationMs: latencyMs,
                }
              : item,
          ),
        );
      } else {
        setRunHistory((prev) =>
          prev.map((item) =>
            item.id === runId
              ? {
                  ...item,
                  status: "cancelled",
                  durationMs: latencyMs,
                }
              : item,
          ),
        );
      }
      setStatusLine("Orchestration stopped.");
      appendTerminal("Orchestration stopped.");
    } finally {
      setIsRunning(false);
    }
  }, [appendTerminal, currentProject.path, isRunning, prompt, updateAgent]);

  const handleChatAttachmentSelection = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const selected = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (selected.length === 0) {
      appendTerminal("chat attachment error: only image files are supported.");
      return;
    }

    const nextFiles = selected.slice(0, Math.max(0, 3 - chatAttachments.length));
    const loaded = await Promise.all(nextFiles.map(
      (file) => new Promise<ChatAttachment>((resolve, reject) => {
        if (file.size > 5 * 1024 * 1024) {
          reject(new Error(`${file.name} exceeds 5 MB.`));
          return;
        }

        const reader = new FileReader();
        reader.onload = () => resolve({
          name: file.name,
          mimeType: file.type,
          dataUrl: typeof reader.result === "string" ? reader.result : "",
          sizeBytes: file.size,
        });
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
        reader.readAsDataURL(file);
      }),
    )).catch((error: Error) => {
      appendTerminal(`chat attachment error: ${error.message}`);
      return [] as ChatAttachment[];
    });

    if (loaded.length > 0) {
      setChatAttachments((prev) => [...prev, ...loaded].slice(0, 3));
      appendTerminal(`chat attachment: loaded ${loaded.length} image${loaded.length > 1 ? "s" : ""}.`);
    }
  }, [appendTerminal, chatAttachments.length]);

  const sendChat = useCallback(async (forcedMessage?: string) => {
    const rawMessage = (forcedMessage ?? chatInput).trim();
    const attachmentsToSend = forcedMessage ? [] : chatAttachments;
    const message = rawMessage || (attachmentsToSend.length > 0 ? "Please analyze the attached image(s) and explain what you see." : "");
    if ((!message && attachmentsToSend.length === 0) || isChatting || isRunning) {
      return;
    }

    const userContent = attachmentsToSend.length > 0
      ? `${rawMessage || "[Image analysis request]"}\n\n[Attached images: ${attachmentsToSend.map((attachment) => attachment.name).join(", ")}]`
      : message;

    pushChatMessage("user", userContent);
    appendTerminal(`chat> ${rawMessage || "[image analysis request]"}`);
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
          attachments: attachmentsToSend.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl })),
          history: chatMessages.slice(-12).map((entry) => ({ role: entry.role, content: entry.content })),
        }),
      });

      if (!response.ok) {
        throw new Error(`Chat failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        reply?: string;
        suggestions?: string[];
        shouldDelegate?: boolean;
        delegatePrompt?: string;
      };
      const reply = data.reply?.trim() || "No reply was generated.";
      if (!forcedMessage) {
        setChatAttachments([]);
      }
      setChatMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
          role: "assistant",
          content: reply,
          suggestions: data.suggestions ?? [],
          createdAt: Date.now(),
        },
      ]);

      if (data.shouldDelegate) {
        const nextPrompt = data.delegatePrompt || message;
        appendTerminal("Cr8or AI prepared delegation plan.");

        if (delegationPolicy === "chat-only") {
          setStatusLine("Delegation skipped by policy (chat-only).");
          appendTerminal("Delegation skipped by policy.");
        } else if (delegationPolicy === "ask") {
          setPendingDelegation({ prompt: nextPrompt, response: reply });
          setPendingPromptDraft(nextPrompt);
          setStatusLine("Delegation plan ready for approval.");
          appendTerminal("Delegation queued for approval.");
        } else {
          setStatusLine("Cr8or AI is delegating execution...");
          await runOrchestration(nextPrompt, "chat");
        }
      } else {
        setStatusLine("Cr8or AI responded in conversational mode.");
        appendTerminal("Cr8or AI answered without running agents.");
      }
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
  }, [appendTerminal, chatAttachments, chatInput, chatMessages, delegationPolicy, isChatting, isRunning, pushChatMessage, runOrchestration]);

  const commandItems: CommandItem[] = [
    {
      id: "run-agents",
      label: "Cr8or AI: Delegate Current Task",
      keywords: ["run", "delegate", "agents", "execute"],
      run: () => {
        setIsPaletteOpen(false);
        void runOrchestration(prompt, "manual");
      },
    },
    {
      id: "stop-agents",
      label: "Cr8or AI: Stop Current Run",
      keywords: ["stop", "cancel", "abort", "run"],
      run: () => {
        abortRef.current?.abort();
        setIsPaletteOpen(false);
      },
    },
    {
      id: "toggle-explorer",
      label: showExplorer ? "View: Hide Explorer" : "View: Show Explorer",
      keywords: ["view", "explorer", "sidebar"],
      run: () => {
        setShowExplorer((prev) => !prev);
        setIsPaletteOpen(false);
      },
    },
    {
      id: "toggle-right",
      label: showRightPane ? "View: Hide Agent Panel" : "View: Show Agent Panel",
      keywords: ["view", "panel", "agents", "right"],
      run: () => {
        setShowRightPane((prev) => !prev);
        setIsPaletteOpen(false);
      },
    },
    {
      id: "toggle-bottom",
      label: showBottomPanel ? "View: Hide Bottom Panel" : "View: Show Bottom Panel",
      keywords: ["view", "terminal", "bottom", "panel"],
      run: () => {
        setShowBottomPanel((prev) => !prev);
        setIsPaletteOpen(false);
      },
    },
    {
      id: "open-chat",
      label: "Cr8or AI: Focus Chat",
      keywords: ["chat", "focus", "assistant"],
      run: () => {
        setIsPaletteOpen(false);
        setActiveTabId("cr8or-ai.chat");
        setIsPaletteOpen(false);
        setTimeout(() => chatInputRef.current?.focus(), 0);
      },
    },
    {
      id: "policy-auto",
      label: "Policy: Auto Delegate",
      keywords: ["policy", "auto", "delegate"],
      run: () => {
        setDelegationPolicy("auto");
        setIsPaletteOpen(false);
      },
    },
    {
      id: "policy-ask",
      label: "Policy: Ask Before Delegating",
      keywords: ["policy", "ask", "approval"],
      run: () => {
        setDelegationPolicy("ask");
        setIsPaletteOpen(false);
      },
    },
    {
      id: "policy-chat-only",
      label: "Policy: Chat Only",
      keywords: ["policy", "chat", "only"],
      run: () => {
        setDelegationPolicy("chat-only");
        setIsPaletteOpen(false);
      },
    },
    {
      id: "replay-last-run",
      label: "Cr8or AI: Replay Last Run",
      keywords: ["replay", "history", "run", "retry"],
      run: () => {
        if (runHistory[0]) {
          replayRun(runHistory[0]);
        }
        setIsPaletteOpen(false);
      },
    },
    {
      id: "project-recent",
      label: "Projects: Refresh Recent",
      keywords: ["projects", "recent", "refresh"],
      run: () => {
        void loadRecentProjects();
        setIsPaletteOpen(false);
      },
    },
    {
      id: "git-status",
      label: "GitHub: Check Status",
      keywords: ["git", "status", "github"],
      run: () => {
        void runGitStatus();
        setIsPaletteOpen(false);
      },
    },
    {
      id: "git-push",
      label: "GitHub: Commit and Push",
      keywords: ["git", "push", "commit", "github"],
      run: () => {
        void runCommitPush();
        setIsPaletteOpen(false);
      },
    },
    {
      id: "deploy-project",
      label: "Deploy: Ship Current Project",
      keywords: ["deploy", "vercel", "ship"],
      run: () => {
        void runDeploy();
        setIsPaletteOpen(false);
      },
    },
    {
      id: "github-api-repos",
      label: "GitHub API: Load Repositories",
      keywords: ["github", "api", "repos", "repositories"],
      run: () => {
        void loadGithubRepos();
        setIsPaletteOpen(false);
      },
    },
    {
      id: "github-api-branches",
      label: "GitHub API: Refresh Branches",
      keywords: ["github", "api", "branches", "refresh"],
      run: () => {
        void loadGithubBranches();
        setIsPaletteOpen(false);
      },
    },
    {
      id: "onboarding",
      label: "Workspace: Open Onboarding Checklist",
      keywords: ["onboarding", "checklist", "workspace", "setup"],
      hint: "Ctrl/Cmd+Shift+P",
      run: () => {
        setIsOnboardingOpen(true);
        setIsPaletteOpen(false);
      },
    },
  ];

  function executePaletteCommand(command: CommandItem) {
    setPaletteRecentIds((prev) => [command.id, ...prev.filter((item) => item !== command.id)].slice(0, 8));
    command.run();
  }

  const filteredCommands = (() => {
    const query = paletteQuery.trim().toLowerCase();
    const recentIndex = new Map(paletteRecentIds.map((id, index) => [id, index]));

    const scored = commandItems
      .map((item) => {
        let score = 0;
        const label = item.label.toLowerCase();
        const keywordMatch = item.keywords.some((term) => term.includes(query));
        if (!query) {
          score = 20;
        } else if (label.startsWith(query)) {
          score = 100;
        } else if (label.includes(query)) {
          score = 80;
        } else if (keywordMatch) {
          score = 60;
        }

        const recentPos = recentIndex.get(item.id);
        if (recentPos !== undefined) {
          score += 20 - recentPos;
        }

        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);

    return scored;
  })();

  useEffect(() => {
    if (filteredCommands.length === 0) {
      setPaletteIndex(0);
      return;
    }

    setPaletteIndex((prev) => {
      if (prev < 0) return 0;
      if (prev >= filteredCommands.length) return filteredCommands.length - 1;
      return prev;
    });
  }, [filteredCommands]);

  const visibleTimeline = useMemo(() => timeline.slice(-MAX_TIMELINE_RENDER), [timeline]);
  const visibleOutputTimeline = useMemo(() => timeline.slice(-MAX_OUTPUT_RENDER), [timeline]);
  const visibleTerminalEntries = useMemo(() => terminalEntries.slice(-MAX_TERMINAL_ENTRIES_RENDER), [terminalEntries]);

  const hiddenTimelineCount = timeline.length - visibleTimeline.length;
  const hiddenOutputTimelineCount = timeline.length - visibleOutputTimeline.length;
  const hiddenTerminalEntriesCount = terminalEntries.length - visibleTerminalEntries.length;

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
    const title = id.split("/").pop() || id;
    setOpenTabs((prev) => {
      if (prev.some((tab) => tab.id === id)) {
        return prev;
      }
      return [...prev, { id, title }];
    });
    setActiveTabId(id);
    void loadFileContent(id);
  }

  function approveDelegation() {
    if (!pendingDelegation) return;
    const approvedPrompt = pendingPromptDraft.trim() || pendingDelegation.prompt;
    setPendingDelegation(null);
    setPendingPromptDraft("");
    appendTerminal("Delegation approved by user.");
    void runOrchestration(approvedPrompt, "chat");
  }

  function cancelDelegation() {
    setPendingDelegation(null);
    setPendingPromptDraft("");
    setStatusLine("Delegation cancelled.");
    appendTerminal("Delegation request cancelled.");
  }

  function replayRun(item: RunHistoryItem) {
    setActiveTabId("cr8or-ai.chat");
    setChatInput(item.prompt);
    void runOrchestration(item.prompt, "manual");
  }

  function completeOnboarding() {
    setIsOnboardingOpen(false);
    try {
      localStorage.setItem(ONBOARDING_KEY, "true");
    } catch {
      // no-op
    }
    appendTerminal("Onboarding completed.");
  }

  function runTerminalCommand() {
    const raw = terminalCommand.trim();
    if (!raw) {
      return;
    }
    setTerminalCommand("");
    appendTerminal(`$ ${raw}`);

    if (raw === "help") {
      appendTerminal("Commands: run, stop, status, clear, chat <text>, policy <auto|ask|chat-only>, replay last, retry last failed, project create <name>, project open <path>, project clone <url>, git status, git push, deploy, github repos, github branches, github read <path>, github save, github pr, github checks <number>, show explorer, hide explorer, show panel, hide panel");
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
    if (raw.startsWith("policy ")) {
      const mode = raw.slice(7).trim() as DelegationPolicy;
      if (mode === "auto" || mode === "ask" || mode === "chat-only") {
        setDelegationPolicy(mode);
        appendTerminal(`Delegation policy set to ${mode}.`);
      } else {
        appendTerminal("Usage: policy <auto|ask|chat-only>");
      }
      return;
    }
    if (raw === "replay last") {
      if (!runHistory[0]) {
        appendTerminal("No run history available.");
        return;
      }
      replayRun(runHistory[0]);
      return;
    }
    if (raw === "retry last failed") {
      const failed = runHistory.find((item) => item.status === "failed" || item.status === "cancelled");
      if (!failed) {
        appendTerminal("No failed/cancelled run available.");
        return;
      }
      replayRun(failed);
      return;
    }
    if (raw.startsWith("project create ")) {
      const name = raw.replace("project create ", "").trim();
      setProjectNameInput(name);
      void createProject(name);
      return;
    }
    if (raw.startsWith("project open ")) {
      const nextPath = raw.replace("project open ", "").trim();
      void openProjectByPath(nextPath);
      return;
    }
    if (raw.startsWith("project clone ")) {
      const url = raw.replace("project clone ", "").trim();
      setRepositoryInput(url);
      void cloneGithubProject(url);
      return;
    }
    if (raw === "git status") {
      void runGitStatus();
      return;
    }
    if (raw === "git push") {
      void runCommitPush();
      return;
    }
    if (raw === "deploy") {
      void runDeploy();
      return;
    }
    if (raw === "github repos") {
      void loadGithubRepos();
      return;
    }
    if (raw === "github branches") {
      void loadGithubBranches();
      return;
    }
    if (raw.startsWith("github read ")) {
      const targetPath = raw.replace("github read ", "").trim();
      if (!targetPath) {
        appendTerminal("Usage: github read <path>");
        return;
      }
      setGithubPath(targetPath);
      void readGithubFile(targetPath);
      return;
    }
    if (raw === "github save") {
      void saveGithubFile();
      return;
    }
    if (raw === "github pr") {
      void createGithubPr();
      return;
    }
    if (raw.startsWith("github checks ")) {
      const value = raw.replace("github checks ", "").trim();
      setGithubPrNumber(value);
      void loadPrChecks();
      return;
    }
    appendTerminal(`Unknown command: ${raw}`);
  }

  const agentList = Array.from(dashboard.values());
  const running = agentList.filter((a) => a.status === "running").length;
  const completed = agentList.filter((a) => a.status === "completed").length;
  const activeDocument = fileContentByPath[activeTabId] ?? "";
  const isMarkdownDocument = isMarkdownPath(activeTabId);
  const activeDocumentLineCount = Math.max(activeDocument.split("\n").length, 1);
  const activeExtension = getFileExtension(activeTabId);
  const activeLanguage = isMarkdownDocument
    ? "markdown"
    : (LANGUAGE_BY_EXTENSION[activeExtension] ?? (activeExtension || "text"));
  const highlightedDocumentHtml = useMemo(() => {
    if (isMarkdownDocument || activeTabId === "cr8or-ai.chat") {
      return "";
    }
    const extension = getFileExtension(activeTabId);
    const mappedLanguage = LANGUAGE_BY_EXTENSION[extension];
    try {
      if (mappedLanguage) {
        return hljs.highlight(activeDocument, { language: mappedLanguage }).value;
      }
      return hljs.highlightAuto(activeDocument).value;
    } catch {
      return hljs.highlightAuto(activeDocument).value;
    }
  }, [activeDocument, activeTabId, isMarkdownDocument]);

  return (
    <>
      {isOnboardingOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-xl rounded-lg border border-[#3a3a3a] bg-[#1f1f1f] p-4">
            <p className="text-sm font-semibold text-[#d4d4d4]">Welcome to Cr8or Studio</p>
            <p className="mt-1 text-xs text-[#9f9f9f]">Complete this setup checklist to make the workspace fully operational.</p>
            <div className="mt-3 space-y-2 text-xs text-[#c8c8c8]">
              <p>1. Configure keys in .env.local for AI, GitHub, and Vercel.</p>
              <p>2. Open Source Control and run Secrets Readiness check.</p>
              <p>3. Select a policy profile: strict, balanced, or autonomous.</p>
              <p>4. Run dry-run previews before first commit/push and deploy.</p>
              <p>5. Review pending approvals in Approval Center.</p>
            </div>
            <div className="mt-4 flex gap-2">
              <Button className="h-8 text-xs" onClick={completeOnboarding}>Complete Setup</Button>
              <Button className="h-8 text-xs" onClick={() => setIsOnboardingOpen(false)}>Remind Me Later</Button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        className={`vscode-shell min-h-screen w-full text-[#cccccc] ${showExplorer ? "is-explorer-open" : "is-explorer-closed"}`}
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
              <div className="flex items-center justify-between">
                <p className="font-medium">GitHub Activity</p>
                <Button className="h-6 px-2 text-[10px]" onClick={() => void runGitStatus()} disabled={isGitBusy || isGithubApiBusy}>
                  {isGitBusy ? "Refreshing..." : "Refresh"}
                </Button>
              </div>

              <div className="rounded border border-[#353535] bg-[#2a2a2a] p-2">
                <p className="text-[11px] text-[#d4d4d4]">Branch: {gitSnapshot?.branch || "unknown"}</p>
                <p className="text-[10px] text-[#8f8f8f]">Changes: {gitSnapshot?.changedCount ?? 0}</p>
                {gitSnapshot?.updatedAt ? (
                  <p className="text-[10px] text-[#6f6f6f]">Updated: {new Date(gitSnapshot.updatedAt).toLocaleTimeString()}</p>
                ) : null}
              </div>

              {gitSnapshot?.changedFiles && gitSnapshot.changedFiles.length > 0 ? (
                <div className="space-y-1">
                  {gitSnapshot.changedFiles.slice(0, 12).map((change) => (
                    <div key={`${change.status}-${change.path}`} className="rounded border border-[#343434] bg-[#232323] px-2 py-1">
                      <button
                        type="button"
                        onClick={() => void loadDiffPreview(change.path)}
                        className="w-full truncate text-left text-[11px] text-[#cccccc] underline-offset-2 hover:underline"
                      >
                        {change.path}
                      </button>
                      <p className="text-[10px] text-[#8f8f8f]">status: {change.status}</p>
                      <div className="mt-1 grid grid-cols-2 gap-1">
                        <Button className="h-6 text-[10px]" onClick={() => void stageFile(change.path, "stage")} disabled={isDiffBusy}>Stage</Button>
                        <Button className="h-6 text-[10px]" onClick={() => void stageFile(change.path, "unstage")} disabled={isDiffBusy}>Unstage</Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[#8f8f8f]">Working tree is clean.</p>
              )}

              {selectedDiffPath ? (
                <div className="rounded border border-[#343434] bg-[#202020] p-2">
                  <p className="mb-1 truncate text-[11px] text-[#d4d4d4]">Diff Preview: {selectedDiffPath}</p>
                  <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-[10px] text-[#9f9f9f]">
                    {diffPreview || "No unstaged diff."}
                  </pre>
                  <p className="mb-1 mt-2 text-[10px] text-[#9f9f9f]">Staged diff</p>
                  <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-[10px] text-[#9f9f9f]">
                    {stagedDiffPreview || "No staged diff."}
                  </pre>
                </div>
              ) : null}

              {gitSnapshot?.recentCommits ? (
                <div className="rounded border border-[#343434] bg-[#242424] p-2">
                  <p className="mb-1 text-[11px] text-[#d4d4d4]">Recent Commits</p>
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-[#9f9f9f]">{gitSnapshot.recentCommits}</pre>
                </div>
              ) : null}

              <input
                value={gitCommitMessage}
                onChange={(event) => setGitCommitMessage(event.target.value)}
                placeholder="Commit message"
                className="vscode-terminal-input"
              />

              <div className="grid grid-cols-3 gap-2">
                <Button className="h-7 text-xs" onClick={() => void runGitStatus()} disabled={isGitBusy}>Status</Button>
                <Button className="h-7 text-xs" onClick={() => void previewCommitPush()} disabled={isGitBusy}>Preview</Button>
                <Button className="h-7 text-xs" onClick={() => void runCommitPush()} disabled={isGitBusy}>Commit + Push</Button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button className="h-7 text-xs" onClick={() => void previewDeploy()} disabled={isGitBusy}>Preview Deploy</Button>
                <Button className="h-7 text-xs" onClick={() => void runDeploy()} disabled={isGitBusy}>Deploy Current Project</Button>
              </div>

              <div className="my-2 border-t border-[#363636] pt-2" />

              <div className="flex items-center justify-between">
                <p className="font-medium">Secrets Readiness</p>
                <Button className="h-6 px-2 text-[10px]" onClick={() => void loadSecretReadiness()} disabled={isSecretReadinessBusy}>
                  {isSecretReadinessBusy ? "Checking..." : "Check"}
                </Button>
              </div>

              {secretReadiness ? (
                <div className="rounded border border-[#353535] bg-[#232323] p-2">
                  <p className="text-[10px] text-[#9f9f9f]">AI provider: {secretReadiness.provider}</p>
                  <div className="mt-1 grid grid-cols-2 gap-1 text-[10px]">
                    <p className={secretReadiness.checks.ai ? "text-[#8fd18f]" : "text-[#f48771]"}>AI: {secretReadiness.checks.ai ? "ready" : "missing"}</p>
                    <p className={secretReadiness.checks.deepseek ? "text-[#8fd18f]" : "text-[#f48771]"}>DeepSeek: {secretReadiness.checks.deepseek ? "ready" : "missing"}</p>
                    <p className={secretReadiness.checks.github ? "text-[#8fd18f]" : "text-[#f48771]"}>GitHub: {secretReadiness.checks.github ? "ready" : "missing"}</p>
                    <p className={secretReadiness.checks.vercel ? "text-[#8fd18f]" : "text-[#f48771]"}>Vercel: {secretReadiness.checks.vercel ? "ready" : "missing"}</p>
                    <p className={secretReadiness.checks.supabase ? "text-[#8fd18f]" : "text-[#f48771]"}>Supabase: {secretReadiness.checks.supabase ? "ready" : "missing"}</p>
                  </div>
                  {secretReadiness.missing.ai.length > 0 || secretReadiness.missing.github.length > 0 || secretReadiness.missing.vercel.length > 0 || secretReadiness.missing.supabase.length > 0 ? (
                    <p className="mt-1 text-[10px] text-[#f48771]">
                      Missing: {[...secretReadiness.missing.ai, ...secretReadiness.missing.github, ...secretReadiness.missing.vercel, ...secretReadiness.missing.supabase].join(", ")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {secretReadinessStatus ? (
                <p className="text-[10px] text-[#8f8f8f]">{secretReadinessStatus}</p>
              ) : null}

              <div className="my-2 border-t border-[#363636] pt-2" />

              <div className="flex items-center justify-between">
                <p className="font-medium">Policy Profile</p>
                <Button className="h-6 px-2 text-[10px]" onClick={() => void loadApprovals()} disabled={isApprovalsBusy}>
                  {isApprovalsBusy ? "Refreshing..." : "Refresh"}
                </Button>
              </div>

              <select
                value={policyProfile}
                onChange={(event) => void updatePolicyProfile(event.target.value as PolicyProfile)}
                className="vscode-terminal-input"
              >
                <option value="strict">strict</option>
                <option value="balanced">balanced</option>
                <option value="autonomous">autonomous</option>
              </select>

              <div className="rounded border border-[#353535] bg-[#232323] p-2">
                <p className="mb-1 text-[10px] text-[#9f9f9f]">Approval Center</p>
                {approvals.length === 0 ? (
                  <p className="text-[10px] text-[#8f8f8f]">No approval requests yet.</p>
                ) : (
                  <div className="max-h-36 space-y-1 overflow-auto">
                    {approvals.slice(0, 20).map((approval) => (
                      <div key={approval.id} className="rounded border border-[#3a3a3a] bg-[#1f1f1f] p-1.5">
                        <p className="truncate text-[10px] text-[#d0d0d0]">{approval.title}</p>
                        <p className="text-[10px] text-[#8f8f8f]">{approval.action} · {approval.status}</p>
                        <pre className="max-h-20 overflow-auto whitespace-pre-wrap text-[9px] text-[#9f9f9f]">{approval.preview}</pre>
                        {approval.status === "pending" ? (
                          <div className="mt-1 grid grid-cols-2 gap-1">
                            <Button className="h-6 text-[10px]" onClick={() => void decideApproval(approval, "approved")} disabled={isApprovalsBusy}>Approve</Button>
                            <Button className="h-6 text-[10px]" onClick={() => void decideApproval(approval, "denied")} disabled={isApprovalsBusy}>Deny</Button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {approvalStatus ? (
                <p className="text-[10px] text-[#8f8f8f]">{approvalStatus}</p>
              ) : null}

              <div className="my-2 border-t border-[#363636] pt-2" />

              <div className="flex items-center justify-between">
                <p className="font-medium">GitHub API Mode</p>
                <Button className="h-6 px-2 text-[10px]" onClick={() => void loadGithubRepos()} disabled={isGithubApiBusy}>
                  {isGithubApiBusy ? "Loading..." : "Load Repos"}
                </Button>
              </div>

              <select
                value={githubOwner && githubRepo ? `${githubOwner}/${githubRepo}` : ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  const [owner, repo] = value.split("/");
                  setGithubOwner(owner || "");
                  setGithubRepo(repo || "");
                  setGithubPath("");
                  setGithubFileContent("");
                  setGithubFileSha("");
                  void loadGithubBranches(owner, repo);
                }}
                className="vscode-terminal-input"
              >
                <option value="">Select repository</option>
                {githubRepos.map((repo) => (
                  <option key={repo.id} value={`${repo.owner}/${repo.name}`}>
                    {repo.fullName}{repo.private ? " (private)" : ""}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-2">
                <select
                  value={githubBranch}
                  onChange={(event) => {
                    const nextBranch = event.target.value;
                    setGithubBranch(nextBranch);
                    setGithubHeadBranch(nextBranch);
                  }}
                  className="vscode-terminal-input"
                >
                  <option value="">Branch</option>
                  {githubBranches.map((branch) => (
                    <option key={branch.sha} value={branch.name}>{branch.name}</option>
                  ))}
                </select>
                <Button
                  className="h-7 text-xs"
                  onClick={() => void loadGithubContents()}
                  disabled={isGithubApiBusy || !githubOwner || !githubRepo}
                >
                  List Files
                </Button>
              </div>

              <input
                value={githubPath}
                onChange={(event) => setGithubPath(event.target.value)}
                placeholder="Path in repo (e.g. README.md)"
                className="vscode-terminal-input"
              />

              <div className="grid grid-cols-2 gap-2">
                <Button
                  className="h-7 text-xs"
                  onClick={() => void readGithubFile()}
                  disabled={isGithubApiBusy || !githubPath.trim() || !githubOwner || !githubRepo}
                >
                  Read File
                </Button>
                <Button
                  className="h-7 text-xs"
                  onClick={() => void saveGithubFile()}
                  disabled={isGithubApiBusy || !githubPath.trim() || !githubBranch.trim() || !githubOwner || !githubRepo}
                >
                  Save via API
                </Button>
              </div>

              <textarea
                value={githubFileContent}
                onChange={(event) => setGithubFileContent(event.target.value)}
                rows={6}
                className="vscode-chat-input"
                placeholder="GitHub file content appears here"
              />

              <input
                value={githubCommitMsg}
                onChange={(event) => setGithubCommitMsg(event.target.value)}
                placeholder="GitHub API commit message"
                className="vscode-terminal-input"
              />

              {githubContents.length > 0 ? (
                <div className="rounded border border-[#353535] bg-[#232323] p-2">
                  <p className="mb-1 text-[10px] text-[#9f9f9f]">Repository entries</p>
                  <div className="max-h-24 overflow-auto space-y-1">
                    {githubContents.slice(0, 20).map((item) => (
                      <button
                        key={`${item.path}-${item.sha}`}
                        type="button"
                        className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-[#cfcfcf] hover:bg-[#323232]"
                        onClick={() => {
                          setGithubPath(item.path);
                          if (item.type === "file") {
                            void readGithubFile(item.path);
                          }
                        }}
                      >
                        [{item.type}] {item.path}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="my-2 border-t border-[#363636] pt-2" />

              <p className="font-medium">Branch & PR</p>
              <input
                value={githubNewBranch}
                onChange={(event) => setGithubNewBranch(event.target.value)}
                placeholder="New branch name"
                className="vscode-terminal-input"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={githubBaseBranch}
                  onChange={(event) => setGithubBaseBranch(event.target.value)}
                  placeholder="Base branch"
                  className="vscode-terminal-input"
                />
                <Button
                  className="h-7 text-xs"
                  onClick={() => void createGithubBranch()}
                  disabled={isGithubApiBusy || !githubNewBranch.trim() || !githubBaseBranch.trim()}
                >
                  Create Branch
                </Button>
              </div>

              <input
                value={githubPrTitle}
                onChange={(event) => setGithubPrTitle(event.target.value)}
                placeholder="PR title"
                className="vscode-terminal-input"
              />
              <textarea
                value={githubPrBody}
                onChange={(event) => setGithubPrBody(event.target.value)}
                rows={3}
                className="vscode-chat-input"
                placeholder="PR description"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={githubHeadBranch}
                  onChange={(event) => setGithubHeadBranch(event.target.value)}
                  placeholder="Head branch"
                  className="vscode-terminal-input"
                />
                <Button
                  className="h-7 text-xs"
                  onClick={() => void createGithubPr()}
                  disabled={isGithubApiBusy || !githubPrTitle.trim() || !githubHeadBranch.trim() || !githubBaseBranch.trim()}
                >
                  Create PR
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <input
                  value={githubPrNumber}
                  onChange={(event) => setGithubPrNumber(event.target.value)}
                  placeholder="PR number"
                  className="vscode-terminal-input"
                />
                <Button className="h-7 text-xs" onClick={() => void loadPrChecks()} disabled={isGithubApiBusy || !githubPrNumber.trim()}>
                  Check CI
                </Button>
              </div>

              {githubApiStatus ? (
                <p className="text-[10px] text-[#8f8f8f]">{githubApiStatus}</p>
              ) : null}
              {githubChecksSummary ? (
                <p className="text-[10px] text-[#9ac7f0]">{githubChecksSummary}</p>
              ) : null}
            </div>
          ) : null}

          {activeSidebar === "problems" ? (
            <div className="space-y-2 p-3 text-xs text-[#cccccc]">
              {error ? <p className="text-[#f48771]">1 error: {error}</p> : <p>No active issues detected.</p>}
            </div>
          ) : null}

          {activeSidebar === "extensions" ? (
            <div className="space-y-2 p-3 text-xs text-[#cccccc]">
              <p className="font-medium">Projects & GitHub</p>
              <p className="text-[11px] text-[#9f9f9f]">Active: {currentProject.name} ({currentProject.path})</p>

              <input
                value={projectNameInput}
                onChange={(event) => setProjectNameInput(event.target.value)}
                placeholder="New project name"
                className="vscode-terminal-input"
              />
              <Button className="h-7 w-full text-xs" onClick={() => void createProject()} disabled={isProjectBusy || !projectNameInput.trim()}>
                {isProjectBusy ? "Working..." : "Create Project"}
              </Button>

              <input
                value={projectPathInput}
                onChange={(event) => setProjectPathInput(event.target.value)}
                placeholder="Project path (e.g. projects/my-app)"
                className="vscode-terminal-input"
              />
              <Button className="h-7 w-full text-xs" onClick={() => void openProjectByPath(projectPathInput)} disabled={isProjectBusy || !projectPathInput.trim()}>
                {isProjectBusy ? "Working..." : "Open Project"}
              </Button>

              <input
                value={repositoryInput}
                onChange={(event) => setRepositoryInput(event.target.value)}
                placeholder="https://github.com/org/repo.git"
                className="vscode-terminal-input"
              />
              <Button className="h-7 w-full text-xs" onClick={() => void cloneGithubProject()} disabled={isProjectBusy || !repositoryInput.trim()}>
                {isProjectBusy ? "Working..." : "Clone GitHub Repo"}
              </Button>

              <input
                value={gitCommitMessage}
                onChange={(event) => setGitCommitMessage(event.target.value)}
                placeholder="Commit message"
                className="vscode-terminal-input"
              />
              <div className="grid grid-cols-2 gap-2">
                <Button className="h-7 text-xs" onClick={() => void runGitStatus()} disabled={isGitBusy}>Git Status</Button>
                <Button className="h-7 text-xs" onClick={() => void runCommitPush()} disabled={isGitBusy}>Commit + Push</Button>
              </div>
              <Button className="h-7 w-full text-xs" onClick={() => void runDeploy()} disabled={isGitBusy}>Deploy (Vercel)</Button>

              <div className="rounded border border-[#353535] bg-[#2a2a2a] p-2">
                <p className="mb-1 text-[11px] text-[#bcbcbc]">Recent Projects</p>
                {recentProjects.length === 0 ? (
                  <p className="text-[11px] text-[#8f8f8f]">No recent projects yet.</p>
                ) : (
                  recentProjects.slice(0, 6).map((project) => (
                    <button
                      key={`${project.path}-${project.updatedAt ?? ""}`}
                      type="button"
                      className="block w-full truncate rounded px-1 py-1 text-left text-[11px] text-[#cccccc] hover:bg-[#3a3a3a]"
                      onClick={() => void openProjectByPath(project.path)}
                    >
                      {project.name} ({project.path})
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </aside>
      ) : null}

      <main className="vscode-workbench">
        <div className="vscode-titlebar">
          <span className="truncate text-[11px] text-[#9f9f9f]">Cr8or Studio · {currentProject.path}</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded border border-[#3a3a3a] bg-[#252526] px-2 py-1">
              <CircleHelp className="h-3 w-3 text-[#8f8f8f]" />
              <select
                value={delegationPolicy}
                onChange={(event) => setDelegationPolicy(event.target.value as DelegationPolicy)}
                className="bg-transparent text-[11px] text-[#cccccc] outline-none"
                title="Delegation policy"
              >
                <option value="auto">Auto Delegate</option>
                <option value="ask">Ask Before Run</option>
                <option value="chat-only">Chat Only</option>
              </select>
            </div>
            {isRunning ? (
              <span className="text-[11px] text-[#858585]">
                {running > 0 ? `${running} running` : ""}
                {completed > 0 ? ` · ${completed} done` : ""}
              </span>
            ) : null}
            {!isRunning && leadInsights.latencyMs > 0 ? (
              <span className="text-[11px] text-[#858585]">
                {Math.round(leadInsights.latencyMs / 100) / 10}s · ${leadInsights.estimatedCostUsd.toFixed(4)}
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

        <div className={`vscode-editor-region ${showRightPane ? "is-rightpane-open" : "is-rightpane-hidden"}`}>
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

            {activeTabId === "cr8or-ai.chat" ? (
              <section className="vscode-chatspace">
                <div className="vscode-chat-header">
                  <p className="text-[11px] text-[#9f9f9f]">Chat with Cr8or AI (Software Engineering Lead)</p>
                  <p className="text-[10px] text-[#6b6b6b]">Execution requests auto-delegate. Questions stay conversational.</p>
                </div>

                {pendingDelegation ? (
                  <div className="vscode-delegation-box">
                    <p className="text-[11px] text-[#cfcfcf]">Delegation plan ready for approval</p>
                    <textarea
                      value={pendingPromptDraft}
                      onChange={(event) => setPendingPromptDraft(event.target.value)}
                      className="vscode-chat-input mt-2"
                      rows={3}
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <Button className="h-7 px-3 text-xs" onClick={approveDelegation} disabled={isRunning}>
                        Approve and Run
                      </Button>
                      <button type="button" className="vscode-ghost-btn" onClick={cancelDelegation}>Cancel</button>
                    </div>
                  </div>
                ) : null}

                <div ref={chatScrollRef} className="vscode-chat-log">
                  {chatMessages.map((entry) => (
                    <div key={entry.id} className={`vscode-chat-row ${entry.role === "user" ? "is-user" : "is-assistant"}`}>
                      <div className="vscode-chat-bubble">
                        <p className="mb-1 text-[10px] uppercase tracking-wide text-[#7f7f7f]">
                          {entry.role === "user" ? "You" : "Cr8or AI"}
                        </p>
                        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[#d4d4d4]">{entry.content}</p>
                        {entry.role === "assistant" && entry.suggestions && entry.suggestions.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {entry.suggestions.map((suggestion) => (
                              <button
                                key={`${entry.id}-${suggestion}`}
                                type="button"
                                className="vscode-suggestion-chip"
                                onClick={() => void sendChat(suggestion)}
                                disabled={isChatting || isRunning}
                              >
                                {suggestion}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {isChatting ? (
                    <div className="vscode-chat-row is-assistant">
                      <div className="vscode-chat-bubble">
                        <p className="text-[12px] text-[#9f9f9f]">Cr8or AI is thinking…</p>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="vscode-chat-input-wrap">
                  <input
                    ref={chatFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void handleChatAttachmentSelection(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                  {chatAttachments.length > 0 ? (
                    <div className="vscode-chat-attachments">
                      {chatAttachments.map((attachment) => (
                        <span key={`${attachment.name}-${attachment.sizeBytes}`} className="vscode-chat-attachment-chip">
                          <span className="truncate">{attachment.name}</span>
                          <button
                            type="button"
                            className="rounded p-0.5 text-[#9f9f9f] hover:bg-[#3a3d41] hover:text-[#ffffff]"
                            onClick={() => setChatAttachments((prev) => prev.filter((item) => item !== attachment))}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
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
                    placeholder="Tell Cr8or AI what to build, or ask for strategy and suggestions..."
                  />
                  <div className="vscode-chat-actions">
                    <div className="flex items-center gap-2 max-[700px]:w-full max-[700px]:justify-between">
                      <button
                        type="button"
                        className="vscode-ghost-btn"
                        onClick={() => chatFileInputRef.current?.click()}
                        disabled={isChatting || isRunning || chatAttachments.length >= 3}
                      >
                        Add Images
                      </button>
                      <button
                        type="button"
                        className="vscode-ghost-btn"
                        onClick={() => {
                          setChatMessages((prev) => prev.slice(0, 1));
                          setChatAttachments([]);
                        }}
                        disabled={isChatting || (chatMessages.length <= 1 && chatAttachments.length === 0)}
                      >
                        Clear
                      </button>
                    </div>
                    <Button
                      className="h-7 gap-1.5 rounded-sm border border-[#3c3c3c] bg-[#0e639c] px-3 text-xs text-white hover:bg-[#1177bb] max-[700px]:w-full"
                      onClick={() => void sendChat()}
                      disabled={isChatting || isRunning || (chatInput.trim().length === 0 && chatAttachments.length === 0)}
                    >
                      {(isChatting || isRunning) ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Send
                    </Button>
                  </div>
                </div>
              </section>
            ) : (
              <section className="vscode-docspace">
                <div className="vscode-doc-header">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[11px] text-[#9f9f9f]">Document: {activeTabId}</p>
                    <div className="flex items-center gap-1.5">
                      <span className="vscode-language-badge">{activeLanguage}</span>
                      <span className="text-[10px] text-[#7f7f7f]">{activeDocumentLineCount} lines</span>
                    </div>
                  </div>
                </div>
                {loadingFilePath === activeTabId ? (
                  <div className="p-3 text-xs text-[#9f9f9f]">Loading {activeTabId}...</div>
                ) : null}
                {fileErrorByPath[activeTabId] ? (
                  <div className="p-3 text-xs text-[#f48771]">{fileErrorByPath[activeTabId]}</div>
                ) : null}
                {!loadingFilePath && !fileErrorByPath[activeTabId] ? (
                  isMarkdownDocument ? (
                    <article className="vscode-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {activeDocument || "No content loaded."}
                      </ReactMarkdown>
                    </article>
                  ) : (
                    <div className="vscode-doc-codewrap">
                      <div className="vscode-doc-lines" aria-hidden="true">
                        {Array.from({ length: activeDocumentLineCount }).map((_, index) => (
                          <span key={index}>{index + 1}</span>
                        ))}
                      </div>
                      <pre className="vscode-doc-content">
                        <code dangerouslySetInnerHTML={{ __html: highlightedDocumentHtml || "No content loaded." }} />
                      </pre>
                    </div>
                  )
                ) : null}
              </section>
            )}
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
                {hiddenTimelineCount > 0 ? (
                  <p className="text-[10px] text-[#7f7f7f]">Showing latest {visibleTimeline.length} of {timeline.length} outputs.</p>
                ) : null}
                {timeline.length === 0 ? (
                  <p className="text-xs text-[#6b6b6b]">Agent outputs appear here after each work package.</p>
                ) : (
                  visibleTimeline.map((task) => <AgentOutputPanel key={task.id} task={task} />)
                )}
              </div>

              <div className="vscode-panel-header">LEAD INSIGHTS</div>
              <div className="space-y-2 p-3 text-xs text-[#cccccc]">
                <div>
                  <p className="mb-1 text-[#9f9f9f]">Confidence</p>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#303030]">
                    <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500" style={{ width: `${leadInsights.confidence}%` }} />
                  </div>
                  <p className="mt-1 text-[11px] text-[#8f8f8f]">{leadInsights.confidence}%</p>
                </div>
                <div className="rounded border border-[#3a3a3a] bg-[#2a2a2a] p-2">
                  <p className="text-[11px] text-[#bcbcbc]">Latency: {Math.round(leadInsights.latencyMs / 100) / 10}s</p>
                  <p className="text-[11px] text-[#bcbcbc]">Estimated Cost: ${leadInsights.estimatedCostUsd.toFixed(4)}</p>
                  <p className="text-[11px] text-[#bcbcbc]">Risk Signals: {leadInsights.risks.length}</p>
                </div>
                {leadInsights.risks.length > 0 ? (
                  <div className="space-y-1">
                    {leadInsights.risks.slice(0, 3).map((risk) => (
                      <p key={risk} className="text-[11px] text-[#f3c57d]">- {risk}</p>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-[#8f8f8f]">No major risk signals detected in latest run.</p>
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
                  {hiddenTerminalEntriesCount > 0 ? (
                    <p className="text-[10px] text-[#7f7f7f]">Showing latest {visibleTerminalEntries.length} of {terminalEntries.length} terminal entries.</p>
                  ) : null}
                  <pre className="vscode-terminal-log font-mono text-[11px] text-[#cccccc]">
                    {visibleTerminalEntries.map((entry) => entry.text).join("\n")}
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
                  {hiddenOutputTimelineCount > 0 ? (
                    <p className="text-[10px] text-[#7f7f7f]">Showing latest {visibleOutputTimeline.length} of {timeline.length} status lines.</p>
                  ) : null}
                  {timeline.length === 0 ? <p>No output yet.</p> : visibleOutputTimeline.map((task) => <p key={task.id}>[{task.agentId}] {task.status}</p>)}
                  {runHistory[0] ? (
                    <p className="pt-2 text-[#9f9f9f]">
                      Last run: {runHistory[0].status} · {Math.round(runHistory[0].durationMs / 100) / 10}s · ${runHistory[0].estimatedCostUsd.toFixed(4)}
                    </p>
                  ) : null}
                  {synthesis ? (
                    <p className="pt-2 text-[#9f9f9f]">Synthesis ready: requirements {synthesis.requirements.length}, architecture {synthesis.architecture.length}, quality {synthesis.quality.length}</p>
                  ) : null}
                </div>
              ) : null}
              {activeBottomTab === "debug" ? (
                <pre className="font-mono text-[11px] text-[#cccccc]">
                  {JSON.stringify({
                    running,
                    completed,
                    activeTabId,
                    delegationPolicy,
                    chatMessages: chatMessages.length,
                    terminalEntries: terminalEntries.length,
                    runHistory: runHistory.length,
                    leadInsights,
                  }, null, 2)}
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
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setPaletteIndex((prev) => Math.min(prev + 1, Math.max(filteredCommands.length - 1, 0)));
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setPaletteIndex((prev) => Math.max(prev - 1, 0));
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const selected = filteredCommands[paletteIndex] ?? filteredCommands[0];
                    if (selected) {
                      executePaletteCommand(selected);
                    }
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setIsPaletteOpen(false);
                  }
                }}
                placeholder="Type a command"
                className="w-full bg-transparent text-sm text-[#cccccc] outline-none placeholder:text-[#6b6b6b]"
              />
            </div>
            <div className="max-h-[46vh] overflow-y-auto p-1.5">
              {filteredCommands.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-[#6b6b6b]">No commands found.</p>
              ) : (
                filteredCommands.map((command, index) => (
                  <button
                    key={command.id}
                    type="button"
                    onClick={() => executePaletteCommand(command)}
                    className={`block w-full rounded px-2 py-1.5 text-left text-xs text-[#cccccc] hover:bg-[#094771] ${index === paletteIndex ? "bg-[#094771]" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{command.label}</span>
                      {command.hint ? <span className="text-[10px] text-[#9f9f9f]">{command.hint}</span> : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </>
  );
}
