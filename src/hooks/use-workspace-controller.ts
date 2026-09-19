"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js";
import { projectIdFor, workspaceResponseSchema, type ProjectRef } from "@/lib/workspace/project-ref";

import { OrchestrationProgressEvent } from "@/lib/agents/orchestrator";
import { AgentExecutionState, AgentId, AgentTask, OrchestrationResult } from "@/lib/agents/types";
import type { IntentClass, ToolMode } from "@/lib/intent/types";

const SEED_PROMPT = "";

type DashboardMap = Map<AgentId, AgentExecutionState>;

type PanelTab = "terminal" | "problems" | "output" | "debug";
type SidebarView = "explorer" | "search" | "source-control" | "problems" | "extensions";
export type DelegationPolicy = "auto" | "ask" | "chat-only";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  suggestions?: string[];
  createdAt: number;
  intent?: IntentClass;
  allowedToolMode?: ToolMode;
  requiresExplicitApproval?: boolean;
};

type TerminalEntry = {
  id: string;
  text: string;
};

type RunStatus = "running" | "completed" | "failed" | "cancelled";

export type RunHistoryItem = {
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

type ExecutionReceiptStatus = "verified" | "failed" | "pending";
type ExecutionReceiptKind = "orchestration" | "git" | "deploy" | "github";

export type ExecutionReceipt = {
  id: string;
  kind: ExecutionReceiptKind;
  title: string;
  status: ExecutionReceiptStatus;
  createdAt: number;
  evidence: string[];
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

export type PolicyProfile = "strict" | "balanced" | "autonomous";

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

export function useWorkspaceController() {
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
  const [showBottomPanel, setShowBottomPanel] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set(["src"]));
  const [openTabs, setOpenTabs] = useState<EditorTab[]>([
    { id: "cr8or-ai.chat", title: "cr8or-ai.chat" },
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
  const [executionReceipts, setExecutionReceipts] = useState<ExecutionReceipt[]>([]);
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
  const [projectError, setProjectError] = useState<string | null>(null);
  const [isProjectBusy, setIsProjectBusy] = useState(false);
  const [isGitBusy, setIsGitBusy] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [fileContentByPath, setFileContentByPath] = useState<Record<string, string>>({});
  const [fileErrorByPath, setFileErrorByPath] = useState<Record<string, string>>({});
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);
  const [currentIntent, setCurrentIntent] = useState<{ intent: IntentClass; allowedToolMode: ToolMode; requiresExplicitApproval: boolean } | null>(null);
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([
    { id: "boot-1", text: "$ cr8or --boot" },
    { id: "boot-2", text: "Cr8or AI console ready. Type 'help' in terminal input for commands." },
  ]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "assistant-seed",
      role: "assistant",
      content:
        "Tell me what you want to build, fix, or understand.",
      createdAt: Date.now(),
    },
  ]);
  const [lastOrchestrationResult, setLastOrchestrationResult] = useState<OrchestrationResult | null>(null);

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
    // Only auto-scroll if user is near bottom (within 200px)
    const { scrollTop, scrollHeight, clientHeight } = chatScrollRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;
    if (isNearBottom) {
      chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [chatMessages, timeline, approvals, pendingDelegation]);

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
        executionReceipts: ExecutionReceipt[];
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
      if (Array.isArray(data.executionReceipts)) setExecutionReceipts(data.executionReceipts.slice(0, 80));
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
      executionReceipts,
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
    executionReceipts,
    showBottomPanel,
    showExplorer,
    showRightPane,
    terminalEntries,
    currentProject,
    projectError,
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

  const addExecutionReceipt = useCallback((receipt: Omit<ExecutionReceipt, "id" | "createdAt">) => {
    setExecutionReceipts((prev) => [
      {
        ...receipt,
        id: `receipt-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        createdAt: Date.now(),
      },
      ...prev,
    ].slice(0, 80));
  }, []);

  const loadFileContent = useCallback(async (filePath: string) => {
    if (filePath === "cr8or-ai.chat") return;
    if (fileContentByPath[filePath]) return;

    setLoadingFilePath(filePath);
    setFileErrorByPath((prev) => ({ ...prev, [filePath]: "" }));
    try {
      const response = await fetch(`/api/files?path=${encodeURIComponent(filePath)}&projectId=${encodeURIComponent(projectIdFor(currentProject))}`);
      const payload = (await response.json()) as { content?: string; message?: string };
      if (!response.ok) {
        throw new Error(payload.message || `Unable to open ${filePath}`);
      }
      setFileContentByPath((prev) => ({ ...prev, [filePath]: payload.content ?? "" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open file.";
      setFileErrorByPath((prev) => ({ ...prev, [filePath]: message }));
    } finally {
      setLoadingFilePath((current) => (current === filePath ? null : current));
    }
  }, [fileContentByPath, currentProject]);

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
      const data = (await response.json()) as { projects?: ProjectRef[]; message?: string };
      if (!response.ok) throw new Error(data.message || "Unable to load recent projects.");
      if (Array.isArray(data.projects)) {
        setRecentProjects(data.projects.slice(0, 20));
      }
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : "Unable to load recent projects.");
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

  const performProjectAction = useCallback(async (action: "create" | "open" | "clone", value: string): Promise<boolean> => {
    if (!value.trim()) return false;
    setIsProjectBusy(true);
    setProjectError(null);
    const policyAction = action === "create" ? "project.create" : "project.clone";
    try {
      const response = await fetch("/api/projects/workspace", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(action === "create" ? { name: value } : action === "open" ? { path: value } : { repositoryUrl: value }), approvalId: approvedActionIds[policyAction] }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.requiresApproval) {
          await handleApprovalConflict(policyAction, "Approve project " + action, data);
          setProjectError("Approval requested. Open the workspace to approve, then retry this action.");
          return false;
        }
        throw new Error(data.message || "Unable to " + action + " project.");
      }
      const { project } = workspaceResponseSchema.parse(data);
      setCurrentProject(project);
      setOpenTabs([{ id: "cr8or-ai.chat", title: "cr8or-ai.chat" }]);
      setActiveTabId("cr8or-ai.chat");
      setFileContentByPath({});
      setFileErrorByPath({});
      setGitSnapshot(null);
      setApprovedActionIds(prev => ({ ...prev, [policyAction]: undefined }));
      setProjectNameInput("");
      setRepositoryInput("");
      appendTerminal("Project ready: " + project.name);
      setStatusLine("Project ready: " + project.name);
      await loadRecentProjects();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Project operation failed.";
      setProjectError(message);
      appendTerminal("project error: " + message);
      return false;
    } finally { setIsProjectBusy(false); }
  }, [approvedActionIds, handleApprovalConflict, appendTerminal, loadRecentProjects]);

  const createProject = useCallback((name?: string) => performProjectAction("create", (name ?? projectNameInput).trim()), [performProjectAction, projectNameInput]);
  const openProjectByPath = useCallback((value: string) => performProjectAction("open", value.trim()), [performProjectAction]);
  const cloneGithubProject = useCallback((url?: string) => performProjectAction("clone", (url ?? repositoryInput).trim()), [performProjectAction, repositoryInput]);

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
      const data = (await response.json()) as {
        commit?: string;
        push?: string;
        message?: string;
        requiresApproval?: boolean;
        preview?: unknown;
        receipt?: {
          branch?: string;
          headSha?: string;
          remoteUrl?: string;
          hadCommit?: boolean;
        };
      };
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
      addExecutionReceipt({
        kind: "git",
        title: "Git commit/push",
        status: "verified",
        evidence: [
          `Branch: ${data.receipt?.branch ?? "unknown"}`,
          `HEAD: ${data.receipt?.headSha ?? "unknown"}`,
          `Remote: ${data.receipt?.remoteUrl ?? "unknown"}`,
          `Commit created: ${data.receipt?.hadCommit === false ? "no (nothing to commit)" : "yes"}`,
          data.push ? `Push output: ${data.push.split("\n")[0]}` : "Push output unavailable.",
        ],
      });
      setApprovedActionIds((prev) => ({ ...prev, "git.commit-push": undefined }));
    } catch (err) {
      appendTerminal(`git error: ${err instanceof Error ? err.message : "commit/push failed"}`);
      setStatusLine("Git operation failed.");
      addExecutionReceipt({
        kind: "git",
        title: "Git commit/push",
        status: "failed",
        evidence: [err instanceof Error ? err.message : "commit/push failed"],
      });
    } finally {
      setIsGitBusy(false);
    }
  }, [addExecutionReceipt, appendTerminal, approvedActionIds, currentProject.path, gitCommitMessage, handleApprovalConflict]);

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
      const data = (await response.json()) as {
        logs?: string;
        message?: string;
        requiresApproval?: boolean;
        preview?: unknown;
        receipt?: {
          strategy?: string;
          productionUrl?: string;
          aliasUrl?: string;
          inspectUrl?: string;
        };
      };
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
      addExecutionReceipt({
        kind: "deploy",
        title: "Deployment",
        status: "verified",
        evidence: [
          `Strategy: ${data.receipt?.strategy ?? "unknown"}`,
          data.receipt?.productionUrl ? `Production URL: ${data.receipt.productionUrl}` : "Production URL not reported.",
          data.receipt?.aliasUrl ? `Alias URL: ${data.receipt.aliasUrl}` : "Alias URL not reported.",
          data.receipt?.inspectUrl ? `Inspect URL: ${data.receipt.inspectUrl}` : "Inspect URL not reported.",
        ],
      });
      setApprovedActionIds((prev) => ({ ...prev, "deploy.vercel": undefined }));
    } catch (err) {
      appendTerminal(`deploy error: ${err instanceof Error ? err.message : "deploy failed"}`);
      setStatusLine("Deploy failed.");
      addExecutionReceipt({
        kind: "deploy",
        title: "Deployment",
        status: "failed",
        evidence: [err instanceof Error ? err.message : "deploy failed"],
      });
    } finally {
      setIsGitBusy(false);
    }
  }, [addExecutionReceipt, appendTerminal, approvedActionIds, currentProject.path, handleApprovalConflict]);

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
          projectId: projectIdFor(currentProject),
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
            } else if (event.type === "tool_progress") {
              appendTerminal(`tool:${event.data.agentId} ${event.data.tool} ${event.data.status}`);
              // If tool requires approval, surface it to the user
              if (event.data.requiresApproval && event.data.approvalDetail) {
                const approval = await requestApproval(
                  "files.write",
                  event.data.approvalDetail.reason || "Tool action requires approval",
                  event.data.approvalDetail.preview
                );
                await loadApprovals();
                appendTerminal(`approval requested for ${event.data.tool}: ${approval.id}`);
              }
            } else if (event.type === "batch_complete") {
              const lineText = `Batch ${event.batchIndex + 1}/${event.total} complete.`;
              setStatusLine(lineText);
              appendTerminal(lineText);
            } else if (event.type === "done") {
              setTimeline(event.result.timeline);
              setSynthesis(event.result.synthesis);
              setStatusLine(event.result.summary);
              setLastOrchestrationResult(event.result);
              appendTerminal(`Done: ${event.result.summary}`);

              const completedAgents = event.result.timeline.filter((task) => task.status === "completed").length;
              const insights = summarizeLeadInsights(event.result.timeline, startTime, Date.now());
              setLeadInsights(insights);
              addExecutionReceipt({
                kind: "orchestration",
                title: "Delegated run completed",
                status: "verified",
                evidence: [
                  `Run ID: ${event.result.requestId}`,
                  `Summary: ${event.result.summary}`,
                  `Completed agents: ${completedAgents}/${event.result.timeline.length}`,
                  `Latency: ${Math.round(insights.latencyMs / 100) / 10}s`,
                ],
              });
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

              // Add final assistant message with orchestration result to chat
              const synthesisText = event.result.synthesis
                ? Object.entries(event.result.synthesis)
                    .filter(([, v]) => Array.isArray(v) && v.length > 0)
                    .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}:\n${(v as string[]).map((s) => `- ${s}`).join("\n")}`)
                    .join("\n\n")
                : "No synthesis available.";

              const finalMessage = event.result.summary
                ? `${event.result.summary}\n\n${synthesisText}`
                : synthesisText;

              setChatMessages((prev) => [
                ...prev,
                {
                  id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
                  role: "assistant",
                  content: finalMessage || "The task finished, but Cr8or did not receive a final synthesis.",
                  createdAt: Date.now(),
                },
              ]);

              // Check if any task had workspaceChanged and trigger git refresh
              const hasWorkspaceChanges = event.result.timeline.some((task) => task.workspaceChanged);
              if (hasWorkspaceChanges) {
                appendTerminal("Workspace changes detected, refreshing git status...");
                void runGitStatus();
              }
            } else if (event.type === "error") {
              setError(event.message);
              setActiveBottomTab("problems");
              appendTerminal(`error: ${event.message}`);
              addExecutionReceipt({
                kind: "orchestration",
                title: "Delegated run failed",
                status: "failed",
                evidence: [event.message],
              });
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
        addExecutionReceipt({
          kind: "orchestration",
          title: "Delegated run failed",
          status: "failed",
          evidence: [message],
        });
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
        addExecutionReceipt({
          kind: "orchestration",
          title: "Delegated run cancelled",
          status: "pending",
          evidence: ["Run cancelled by user."],
        });
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
  }, [addExecutionReceipt, appendTerminal, currentProject, isRunning, prompt, updateAgent]);

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

    // Check for follow-up questions about previous orchestration result
    const lowerMessage = rawMessage.toLowerCase();
    const isFollowup = (
      lastOrchestrationResult &&
      (/\bwhere (are|is) the result/.test(lowerMessage) ||
        /\bwhere (are|is) the results?\b/.test(lowerMessage) ||
        /\bwhat did (you|the) (find|result)/.test(lowerMessage) ||
        /\bwhat did the (inspection|review|analysis|scan)\b/.test(lowerMessage) ||
        /\bshow me the (result|results|findings?)\b/.test(lowerMessage) ||
        /\bgive me the result/.test(lowerMessage) ||
        /\bwhat (were|was) the (result|results|findings?)\b/.test(lowerMessage) ||
        /\bsummarize (what|the)\b/.test(lowerMessage) ||
        /\bwhat did the (inspection|review|analysis)\b/.test(lowerMessage))
    );

    if (isFollowup) {
      // Return the last orchestration result directly
      const result = lastOrchestrationResult!;
      const synthesisText = result.synthesis
        ? Object.entries(result.synthesis)
            .filter(([, v]) => Array.isArray(v) && v.length > 0)
            .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}:\n${(v as string[]).map((s) => `- ${s}`).join("\n")}`)
            .join("\n\n")
        : "No synthesis available.";

      const finalMessage = result.summary
        ? `${result.summary}\n\n${synthesisText}`
        : synthesisText;

      pushChatMessage("assistant", finalMessage || "The task finished, but Cr8or did not receive a final synthesis.");
      appendTerminal("Follow-up answered from previous orchestration result.");
      setStatusLine("Answered from previous result.");
      setIsChatting(false);
      return;
    }



    try {
      const response = await fetch("/api/chat/main", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          projectId: projectIdFor(currentProject),
          delegationPolicy,
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
        intent?: string;
        allowedToolMode?: string;
        requiresExplicitApproval?: boolean;
      };
      const reply = data.reply?.trim() || "No reply was generated.";
      if (!forcedMessage) {
        setChatAttachments([]);
      }
      if (data.intent) {
        setCurrentIntent({
          intent: data.intent as IntentClass,
          allowedToolMode: data.allowedToolMode as ToolMode,
          requiresExplicitApproval: data.requiresExplicitApproval ?? false,
        });
      }
      setChatMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
          role: "assistant",
          content: reply,
          suggestions: data.suggestions ?? [],
          createdAt: Date.now(),
          intent: data.intent as IntentClass,
          allowedToolMode: data.allowedToolMode as ToolMode,
          requiresExplicitApproval: data.requiresExplicitApproval,
        },
      ]);

      if (data.shouldDelegate) {
        const nextPrompt = data.delegatePrompt || message;
        if (data.intent) {
          setCurrentIntent({
            intent: data.intent as IntentClass,
            allowedToolMode: data.allowedToolMode as ToolMode,
            requiresExplicitApproval: data.requiresExplicitApproval ?? false,
          });
        }
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
          void runOrchestration(nextPrompt, "chat");
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
  }, [appendTerminal, chatAttachments, chatInput, chatMessages, delegationPolicy, isChatting, isRunning, pushChatMessage, runOrchestration, lastOrchestrationResult, currentProject]);

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
  const visibleReceipts = useMemo(() => executionReceipts.slice(0, 12), [executionReceipts]);

  const hiddenTimelineCount = timeline.length - visibleTimeline.length;
  const hiddenOutputTimelineCount = timeline.length - visibleOutputTimeline.length;
  const hiddenTerminalEntriesCount = terminalEntries.length - visibleTerminalEntries.length;
  const hiddenReceiptCount = executionReceipts.length - visibleReceipts.length;

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

  return {
    prompt,
    delegationPolicy,
    setDelegationPolicy,
    isRunning,
    timeline,
    synthesis,
    statusLine,
    error,
    activeSidebar,
    setActiveSidebar,
    activeBottomTab,
    setActiveBottomTab,
    showExplorer,
    setShowExplorer,
    showRightPane,
    showBottomPanel,
    setShowBottomPanel,
    collapsedFolders,
    openTabs,
    activeTabId,
    setActiveTabId,
    isPaletteOpen,
    setIsPaletteOpen,
    paletteQuery,
    setPaletteQuery,
    paletteIndex,
    setPaletteIndex,
    chatInput,
    setChatInput,
    chatAttachments,
    setChatAttachments,
    isChatting,
    pendingDelegation,
    pendingPromptDraft,
    setPendingPromptDraft,
    leadInsights,
    runHistory,
    executionReceipts,
    currentProject,
    recentProjects,
    gitSnapshot,
    selectedDiffPath,
    diffPreview,
    stagedDiffPreview,
    isDiffBusy,
    githubRepos,
    githubBranches,
    githubContents,
    githubOwner,
    setGithubOwner,
    githubRepo,
    setGithubRepo,
    githubBranch,
    setGithubBranch,
    githubPath,
    setGithubPath,
    setGithubFileSha,
    githubFileContent,
    setGithubFileContent,
    githubCommitMsg,
    setGithubCommitMsg,
    githubNewBranch,
    setGithubNewBranch,
    githubPrTitle,
    setGithubPrTitle,
    githubPrBody,
    setGithubPrBody,
    githubBaseBranch,
    setGithubBaseBranch,
    githubHeadBranch,
    setGithubHeadBranch,
    githubPrNumber,
    setGithubPrNumber,
    githubApiStatus,
    githubChecksSummary,
    isGithubApiBusy,
    secretReadiness,
    secretReadinessStatus,
    isSecretReadinessBusy,
    policyProfile,
    approvals,
    isApprovalsBusy,
    approvalStatus,
    isOnboardingOpen,
    setIsOnboardingOpen,
    projectNameInput,
    setProjectNameInput,
    projectPathInput,
    setProjectPathInput,
    repositoryInput,
    setRepositoryInput,
    gitCommitMessage,
    setGitCommitMessage,
    isProjectBusy,
    isGitBusy,
    terminalCommand,
    setTerminalCommand,
    fileErrorByPath,
    loadingFilePath,
    terminalEntries,
    chatMessages,
    setChatMessages,
    paletteInputRef,
    chatInputRef,
    chatFileInputRef,
    chatScrollRef,
    updatePolicyProfile,
    loadApprovals,
    decideApproval,
    createProject,
    openProjectByPath,
    cloneGithubProject,
    runGitStatus,
    runCommitPush,
    loadDiffPreview,
    stageFile,
    previewCommitPush,
    runDeploy,
    previewDeploy,
    loadGithubRepos,
    loadGithubBranches,
    loadGithubContents,
    readGithubFile,
    saveGithubFile,
    createGithubBranch,
    createGithubPr,
    loadPrChecks,
    loadSecretReadiness,
    runOrchestration,
    handleChatAttachmentSelection,
    sendChat,
    executePaletteCommand,
    filteredCommands,
    visibleTimeline,
    visibleOutputTimeline,
    visibleTerminalEntries,
    visibleReceipts,
    hiddenTimelineCount,
    hiddenOutputTimelineCount,
    hiddenTerminalEntriesCount,
    hiddenReceiptCount,
    toggleFolder,
    closeTab,
    openTabFromExplorer,
    approveDelegation,
    cancelDelegation,
    completeOnboarding,
    runTerminalCommand,
    agentList,
    running,
    completed,
    activeDocument,
    isMarkdownDocument,
    activeDocumentLineCount,
    activeLanguage,
    highlightedDocumentHtml,
    currentIntent,
    projectError,
  };
}
