import { formatGitPullTitle, GIT_PULL_CATEGORIES } from "../../src/lib/security/git-project-naming";

// Loaded only by the standalone runner's fixed alias, never by deployed routes.
// Do not retain the application repository in this test-only allowlist.
export const GIT_PROJECT_CODES = Object.freeze({ "cr8or-verification/pilot-fixture": "VFY" });
export { formatGitPullTitle, GIT_PULL_CATEGORIES };
export function resolveGitProjectCode(repositoryKey: string): string {
  if (repositoryKey !== "cr8or-verification/pilot-fixture") throw new Error("Project naming is not configured for this fixture.");
  return GIT_PROJECT_CODES[repositoryKey];
}
