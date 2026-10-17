import { vi } from "vitest";
import { createGitObjectGithubAdapter } from "./git-object-github-adapter";

/** Read-only Git Database fixture backed by exact bytes from disposable Git
 * repositories. It models documented API shapes, not live GitHub behavior. */
export function createRepositoryGithubAdapter(input: Parameters<typeof createGitObjectGithubAdapter>[0] & {
  expectedCredential: string;
}) {
  const fixture = createGitObjectGithubAdapter(input);
  const authorizationChecks: boolean[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if ((init?.method ?? "GET") !== "GET" || init?.body !== undefined) {
      throw new Error("The repository initialization fixture prohibits remote mutations.");
    }
    const authorized = new Headers(init?.headers).get("Authorization") === `Bearer ${input.expectedCredential}`;
    authorizationChecks.push(authorized);
    if (!authorized) return new Response("{}", { status: 401 });
    return fixture.fetcher(url, init);
  });
  return { ...fixture, fetcher, authorizationChecks };
}
