import "server-only";

/** Reviewed identities, never inferred from request fields or model output.
 * Adding a project requires a reviewed server-side entry. */
export const GIT_PROJECT_CODES: Readonly<Record<string, string>> = Object.freeze({
  "badadeveloper001-dev/cr8or-studio": "CR8OR",
});

export const GIT_PULL_CATEGORIES = Object.freeze([
  "General maintenance", "Code improvements", "Documentation updates",
  "Test improvements", "Configuration updates",
] as const);

export function resolveGitProjectCode(repositoryKey: string): string {
  if (!Object.hasOwn(GIT_PROJECT_CODES, repositoryKey)) throw new Error("Project naming is not configured.");
  return GIT_PROJECT_CODES[repositoryKey];
}

/** Commit N and its corresponding PR share change identifier N. Formatting is
 * not authorization: transports verify trusted history and approved scope. */
export function formatGitPullTitle(projectCode: string, sequence: number, category: string): string {
  if (!/^[A-Z][A-Z0-9]{1,15}$/.test(projectCode) || !Number.isSafeInteger(sequence) ||
      sequence < 1 || sequence > 999_999_999 || !GIT_PULL_CATEGORIES.some(value => value === category)) {
    throw new Error("Pull request naming cannot be verified.");
  }
  return `${projectCode}-${String(sequence).padStart(3, "0")}: ${category}`;
}
