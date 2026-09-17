"use client";

import { useState } from "react";
import {
  Files,
  FolderGit2,
  GitBranch,
  History,
  Home as HomeIcon,
  Play,
  Rocket,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Users,
} from "lucide-react";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { MobileNav } from "@/components/workspace/mobile-nav";
import { MobileSheet, type MobileSheetId } from "@/components/workspace/mobile-sheet";
import { NavRail, type WorkspaceSection } from "@/components/workspace/nav-rail";
import { AgentsTab, ApprovalsTab, RightContextPanel, RunTab } from "@/components/workspace/right-context-panel";
import { ReviewMode } from "@/components/workspace/review/review-mode";
import { SecondarySidebar, SecondarySidebarContent } from "@/components/workspace/secondary-sidebar";
import { TerminalDrawer } from "@/components/workspace/terminal-drawer";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { WorkspaceTopBar } from "@/components/workspace/workspace-top-bar";

type SheetState = MobileSheetId | "more" | null;

const SHEET_TITLES: Record<Exclude<SheetState, null>, string> = {
  projects: "Projects",
  files: "Files",
  "source-control": "Source Control",
  agents: "Agents",
  run: "Run",
  approvals: "Approvals",
  deployments: "Deployments",
  history: "History",
  settings: "Settings",
  more: "More",
};

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-3 text-xs leading-relaxed text-text-muted">{children}</p>;
}

function MoreSheet({
  onOpenSheet,
  onNavigate,
  onOpenTerminal,
  onHome,
}: {
  onOpenSheet: (sheet: MobileSheetId) => void;
  onNavigate: (section: WorkspaceSection) => void;
  onOpenTerminal: () => void;
  onHome: () => void;
}) {
  const items: Array<{ label: string; Icon: typeof FolderGit2; onSelect: () => void }> = [
    { label: "Projects", Icon: FolderGit2, onSelect: () => onNavigate("projects") },
    { label: "Files", Icon: Files, onSelect: () => onNavigate("files") },
    { label: "Source Control", Icon: GitBranch, onSelect: () => onNavigate("source-control") },
    { label: "Agents", Icon: Users, onSelect: () => onOpenSheet("agents") },
    { label: "Run details", Icon: Play, onSelect: () => onOpenSheet("run") },
    { label: "Approvals", Icon: ShieldCheck, onSelect: () => onOpenSheet("approvals") },
    { label: "Terminal", Icon: SquareTerminal, onSelect: onOpenTerminal },
    { label: "Deployments", Icon: Rocket, onSelect: () => onOpenSheet("deployments") },
    { label: "History", Icon: History, onSelect: () => onNavigate("history") },
    { label: "Settings", Icon: Settings, onSelect: () => onNavigate("settings") },
    { label: "Home", Icon: HomeIcon, onSelect: onHome },
  ];

  return (
    <ul>
      {items.map(({ label, Icon, onSelect }) => (
        <li key={label}>
          <button
            type="button"
            onClick={onSelect}
            className="flex h-12 w-full items-center gap-3 rounded-md px-2 text-left text-sm text-text-primary transition-colors hover:bg-surface-muted"
          >
            <Icon className="h-4 w-4 text-text-muted" />
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SheetBody({
  sheet,
  onOpenSheet,
  onNavigate,
  onOpenTerminal,
  onHome,
  onOpenReview,
}: {
  sheet: SheetState;
  onOpenSheet: (sheet: MobileSheetId) => void;
  onNavigate: (section: WorkspaceSection) => void;
  onOpenTerminal: () => void;
  onHome: () => void;
  onOpenReview: (path?: string) => void;
}) {
  if (!sheet) return null;
  if (sheet === "more") {
    return <MoreSheet onOpenSheet={onOpenSheet} onNavigate={onNavigate} onOpenTerminal={onOpenTerminal} onHome={onHome} />;
  }
  if (sheet === "agents") {
    return <AgentsTab />;
  }
  if (sheet === "run") {
    return <RunTab />;
  }
  if (sheet === "approvals") {
    return <ApprovalsTab />;
  }
  if (sheet === "deployments") {
    return <Note>Deploy actions live in Source Control. Open Source Control from the More menu.</Note>;
  }
  return <SecondarySidebarContent section={sheet} onOpenReview={onOpenReview} />;
}

export function WorkspaceView({
  initialSection,
  onExitToHome,
}: {
  initialSection: WorkspaceSection;
  onExitToHome: () => void;
}) {
  const { setShowBottomPanel } = useWorkspaceControllerContext();
  const [section, setSection] = useState<WorkspaceSection>(initialSection);
  const [secondaryOpen, setSecondaryOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewPath, setReviewPath] = useState<string | undefined>(undefined);

  const handleSelectSection = (next: WorkspaceSection) => {
    setSection(next);
    setSecondaryOpen(true);
  };

  const handleOpenTerminal = () => {
    setSheet(null);
    setShowBottomPanel(true);
  };

  const handleOpenReview = (path?: string) => {
    setSheet(null);
    setReviewPath(path);
    setReviewOpen(true);
  };

  const handleReviewChanges = () => {
    handleOpenReview();
  };

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-text-primary">
      <WorkspaceTopBar
        section={section}
        onSelectSection={handleSelectSection}
        onHome={onExitToHome}
        secondaryOpen={secondaryOpen}
        onToggleSecondary={() => setSecondaryOpen((open) => !open)}
        rightOpen={rightOpen}
        onToggleRight={() => setRightOpen((open) => !open)}
        onOpenReview={handleOpenReview}
      />
      <div className="flex min-h-0 flex-1">
        <NavRail active={section} onSelect={handleSelectSection} onHome={onExitToHome} />
        {secondaryOpen ? (
          <SecondarySidebar
            section={section}
            onClose={() => setSecondaryOpen(false)}
            onOpenReview={handleOpenReview}
          />
        ) : null}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WorkspaceShell onReviewChanges={handleReviewChanges} />
        </main>
        {rightOpen ? (
          <RightContextPanel
            onClose={() => setRightOpen(false)}
            onOpenSourceControl={() => handleSelectSection("source-control")}
          />
        ) : null}
      </div>
      <TerminalDrawer />
      <div aria-hidden="true" className="h-14 md:hidden" />
      <MobileNav
        active={section}
        onHome={onExitToHome}
        onWorkspace={() => setSection("tasks")}
        onChanges={() => setSheet("source-control")}
        onMore={() => setSheet("more")}
      />
      <MobileSheet open={sheet !== null} title={sheet ? SHEET_TITLES[sheet] : ""} onClose={() => setSheet(null)}>
        <SheetBody
          sheet={sheet}
          onOpenSheet={(next) => setSheet(next)}
          onNavigate={(next) => {
            handleSelectSection(next);
            setSheet(null);
          }}
          onOpenTerminal={handleOpenTerminal}
          onOpenReview={handleOpenReview}
          onHome={() => {
            setSheet(null);
            onExitToHome();
          }}
        />
      </MobileSheet>
      <ReviewMode open={reviewOpen} initialPath={reviewPath} onClose={() => setReviewOpen(false)} />
    </div>
  );
}
