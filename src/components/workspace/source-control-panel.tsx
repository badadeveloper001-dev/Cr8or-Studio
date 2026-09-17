"use client";

import { useWorkspaceControllerContext } from "@/components/app/workspace-controller-context";
import { Button } from "@/components/ui/button";

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-border-strong bg-surface px-2.5 text-xs text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent";

const TEXTAREA_CLASS =
  "w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-2 text-xs text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">{children}</p>;
}

export function SourceControlPanel({ onOpenReview }: { onOpenReview?: (path?: string) => void }) {
  const {
    gitSnapshot,
    gitCommitMessage,
    setGitCommitMessage,
    isGitBusy,
    isDiffBusy,
    selectedDiffPath,
    diffPreview,
    stagedDiffPreview,
    runGitStatus,
    previewCommitPush,
    runCommitPush,
    loadDiffPreview,
    stageFile,
    previewDeploy,
    runDeploy,
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
    loadGithubRepos,
    loadGithubBranches,
    loadGithubContents,
    readGithubFile,
    saveGithubFile,
    createGithubBranch,
    createGithubPr,
    loadPrChecks,
  } = useWorkspaceControllerContext();

  return (
    <div className="space-y-5 p-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <SectionLabel>Repository</SectionLabel>
          <Button type="button" variant="ghost" size="xs" onClick={() => void runGitStatus()} disabled={isGitBusy || isGithubApiBusy}>
            {isGitBusy ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
        <div className="rounded-md border border-border-strong bg-surface-muted px-3 py-2">
          <p className="truncate text-xs text-text-primary">Branch: {gitSnapshot?.branch || "unknown"}</p>
          <p className="text-[11px] text-text-muted">Changes: {gitSnapshot?.changedCount ?? 0}</p>
          {gitSnapshot?.updatedAt ? (
            <p className="text-[11px] text-text-muted">Updated: {new Date(gitSnapshot.updatedAt).toLocaleTimeString()}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <SectionLabel>Changes</SectionLabel>
          {onOpenReview && (gitSnapshot?.changedFiles.length ?? 0) > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onOpenReview(selectedDiffPath || undefined)}
            >
              Review
            </Button>
          ) : null}
        </div>
        {gitSnapshot?.changedFiles && gitSnapshot.changedFiles.length > 0 ? (
          <ul className="divide-y divide-border-strong">
            {gitSnapshot.changedFiles.slice(0, 12).map((change) => (
              <li key={`${change.status}-${change.path}`} className="py-2">
                <button
                  type="button"
                  onClick={() => void loadDiffPreview(change.path)}
                  className="w-full truncate text-left text-xs text-text-primary underline-offset-2 hover:underline"
                >
                  {change.path}
                </button>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted">{change.status}</span>
                  <div className="flex gap-1">
                    <Button type="button" variant="ghost" size="xs" onClick={() => void stageFile(change.path, "stage")} disabled={isDiffBusy}>
                      Stage
                    </Button>
                    <Button type="button" variant="ghost" size="xs" onClick={() => void stageFile(change.path, "unstage")} disabled={isDiffBusy}>
                      Unstage
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-muted">Working tree is clean.</p>
        )}

        {selectedDiffPath ? (
          <div className="rounded-md border border-border-strong bg-surface-muted p-2.5">
            <p className="mb-1 truncate text-[11px] text-text-secondary">Diff: {selectedDiffPath}</p>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-text-secondary">
              {diffPreview || "No unstaged diff."}
            </pre>
            <p className="mb-1 mt-2 text-[10px] text-text-muted">Staged diff</p>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-text-secondary">
              {stagedDiffPreview || "No staged diff."}
            </pre>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <SectionLabel>Commit</SectionLabel>
        <input
          value={gitCommitMessage}
          onChange={(event) => setGitCommitMessage(event.target.value)}
          placeholder="Commit message"
          aria-label="Commit message"
          className={INPUT_CLASS}
        />
        <div className="grid grid-cols-2 gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={() => void runGitStatus()} disabled={isGitBusy}>
            Status
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void previewCommitPush()} disabled={isGitBusy}>
            Preview
          </Button>
        </div>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="w-full"
          onClick={() => void runCommitPush()}
          disabled={isGitBusy}
        >
          Commit + Push
        </Button>
        <div className="grid grid-cols-2 gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={() => void previewDeploy()} disabled={isGitBusy}>
            Preview deploy
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void runDeploy()} disabled={isGitBusy}>
            Deploy
          </Button>
        </div>
      </div>

      {gitSnapshot?.recentCommits ? (
        <div className="space-y-2">
          <SectionLabel>Recent commits</SectionLabel>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-border-strong bg-surface-muted p-2.5 font-mono text-[10px] text-text-secondary">
            {gitSnapshot.recentCommits}
          </pre>
        </div>
      ) : null}

      <div className="space-y-2 border-t border-border-strong pt-4">
        <div className="flex items-center justify-between">
          <SectionLabel>GitHub API</SectionLabel>
          <Button type="button" variant="ghost" size="xs" onClick={() => void loadGithubRepos()} disabled={isGithubApiBusy}>
            {isGithubApiBusy ? "Loading..." : "Load repos"}
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
          aria-label="Repository"
          className={INPUT_CLASS}
        >
          <option value="">Select repository</option>
          {githubRepos.map((repo) => (
            <option key={repo.id} value={`${repo.owner}/${repo.name}`}>
              {repo.fullName}
              {repo.private ? " (private)" : ""}
            </option>
          ))}
        </select>

        <div className="grid grid-cols-2 gap-1.5">
          <select
            value={githubBranch}
            onChange={(event) => {
              const nextBranch = event.target.value;
              setGithubBranch(nextBranch);
              setGithubHeadBranch(nextBranch);
            }}
            aria-label="Branch"
            className={INPUT_CLASS}
          >
            <option value="">Branch</option>
            {githubBranches.map((branch) => (
              <option key={branch.sha} value={branch.name}>
                {branch.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadGithubContents()}
            disabled={isGithubApiBusy || !githubOwner || !githubRepo}
          >
            List files
          </Button>
        </div>

        <input
          value={githubPath}
          onChange={(event) => setGithubPath(event.target.value)}
          placeholder="Path in repo (e.g. README.md)"
          aria-label="Path in repository"
          className={INPUT_CLASS}
        />

        <div className="grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void readGithubFile()}
            disabled={isGithubApiBusy || !githubPath.trim() || !githubOwner || !githubRepo}
          >
            Read file
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
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
          aria-label="GitHub file content"
          placeholder="GitHub file content appears here"
          className={TEXTAREA_CLASS}
        />

        <input
          value={githubCommitMsg}
          onChange={(event) => setGithubCommitMsg(event.target.value)}
          placeholder="GitHub API commit message"
          aria-label="GitHub API commit message"
          className={INPUT_CLASS}
        />

        {githubContents.length > 0 ? (
          <div className="rounded-md border border-border-strong bg-surface-muted p-2">
            <p className="mb-1 text-[10px] text-text-muted">Repository entries</p>
            <div className="max-h-24 space-y-0.5 overflow-auto">
              {githubContents.slice(0, 20).map((item) => (
                <button
                  key={`${item.path}-${item.sha}`}
                  type="button"
                  className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
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

        {githubApiStatus ? <p className="text-[10px] text-text-muted">{githubApiStatus}</p> : null}
        {githubChecksSummary ? <p className="text-[10px] text-accent">{githubChecksSummary}</p> : null}
      </div>

      <div className="space-y-2 border-t border-border-strong pt-4">
        <SectionLabel>Branch &amp; pull request</SectionLabel>
        <input
          value={githubNewBranch}
          onChange={(event) => setGithubNewBranch(event.target.value)}
          placeholder="New branch name"
          aria-label="New branch name"
          className={INPUT_CLASS}
        />
        <div className="grid grid-cols-2 gap-1.5">
          <input
            value={githubBaseBranch}
            onChange={(event) => setGithubBaseBranch(event.target.value)}
            placeholder="Base branch"
            aria-label="Base branch"
            className={INPUT_CLASS}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void createGithubBranch()}
            disabled={isGithubApiBusy || !githubNewBranch.trim() || !githubBaseBranch.trim()}
          >
            Create branch
          </Button>
        </div>

        <input
          value={githubPrTitle}
          onChange={(event) => setGithubPrTitle(event.target.value)}
          placeholder="PR title"
          aria-label="Pull request title"
          className={INPUT_CLASS}
        />
        <textarea
          value={githubPrBody}
          onChange={(event) => setGithubPrBody(event.target.value)}
          rows={3}
          aria-label="Pull request description"
          placeholder="PR description"
          className={TEXTAREA_CLASS}
        />
        <div className="grid grid-cols-2 gap-1.5">
          <input
            value={githubHeadBranch}
            onChange={(event) => setGithubHeadBranch(event.target.value)}
            placeholder="Head branch"
            aria-label="Head branch"
            className={INPUT_CLASS}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void createGithubPr()}
            disabled={isGithubApiBusy || !githubPrTitle.trim() || !githubHeadBranch.trim() || !githubBaseBranch.trim()}
          >
            Create PR
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <input
            value={githubPrNumber}
            onChange={(event) => setGithubPrNumber(event.target.value)}
            placeholder="PR number"
            aria-label="Pull request number"
            className={INPUT_CLASS}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadPrChecks()}
            disabled={isGithubApiBusy || !githubPrNumber.trim()}
          >
            Check CI
          </Button>
        </div>
      </div>
    </div>
  );
}
