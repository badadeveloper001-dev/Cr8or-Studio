import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createPilotFixture, type PilotFixture } from "../provider-verification/fixtures";
import { createOfflineGithubAdapter, OFFLINE_GITHUB_CREDENTIAL } from "../provider-verification/github-adapter";
import { resolvePrivateGithubRepositoryHead } from "../../src/lib/workspace/private-github-repository-source";

let fixture: PilotFixture;
beforeAll(async () => { fixture = await createPilotFixture(); });
afterAll(async () => { if (fixture) await fs.rm(fixture.root, { recursive: true, force: true }); });
const remote = () => createOfflineGithubAdapter({ repositoryKey: fixture.repositoryKey, branch: fixture.branch,
  head: fixture.head, objects: [...fixture.graph.objects] });
const headers = { Authorization: `Bearer ${OFFLINE_GITHUB_CREDENTIAL}` };
const uri = (suffix = "") => `https://api.github.com/repos/cr8or-verification/pilot-fixture${suffix}`;

describe("standalone offline GitHub transport boundary", () => {
  it("accepts only the compiled synthetic repository and branch", () => {
    expect(() => createOfflineGithubAdapter({ repositoryKey: "badadeveloper001-dev/Cr8or-Studio" as typeof fixture.repositoryKey,
      branch: fixture.branch, head: fixture.head, objects: [] })).toThrow();
    expect(() => createOfflineGithubAdapter({ repositoryKey: fixture.repositoryKey,
      branch: "main" as typeof fixture.branch, head: fixture.head, objects: [] })).toThrow();
  });

  it("has no network fallback for other hosts, repositories, or endpoints", async () => {
    const adapter = remote();
    for (const url of ["https://example.invalid/", "https://api.github.com/repos/other/project",
      uri("/unexpected-provider-operation")]) {
      await expect(adapter.fetcher(url, { headers })).rejects.toThrow();
    }
    expect(adapter.evidence().mutations).toBe(0);
  });

  it("rejects real-looking or missing credentials before fixture operations", async () => {
    const adapter = remote();
    await expect(adapter.fetcher(uri())).rejects.toThrow();
    await expect(adapter.fetcher(uri(), { headers: { Authorization: "Bearer unexpected" } })).rejects.toThrow();
    expect(adapter.evidence().operations).toBe(0);
  });

  it("uses the real source validator to reject wrong repository identity", async () => {
    const adapter = remote();
    const input = { repositoryKey: fixture.repositoryKey, branch: fixture.branch, token: OFFLINE_GITHUB_CREDENTIAL,
      revalidate: async () => undefined, fetch: adapter.fetcher };
    expect(await resolvePrivateGithubRepositoryHead(input)).toBe(fixture.head);
    adapter.setFault("wrong-repository");
    await expect(resolvePrivateGithubRepositoryHead(input)).rejects.toThrow();
    expect(adapter.evidence().mutations).toBe(0);
  });

  it("models a completed branch mutation with lost acknowledgement honestly", async () => {
    const adapter = createOfflineGithubAdapter({ repositoryKey: fixture.repositoryKey, branch: fixture.branch,
      head: fixture.firstHead, objects: [...fixture.graph.objects] });
    adapter.setFault("lost-branch-acknowledgment");
    await expect(adapter.fetcher(uri("/git/refs/heads/pilot"), { method: "PATCH", headers,
      body: JSON.stringify({ sha: fixture.head, force: false }) })).rejects.toThrow();
    expect(adapter.head).toBe(fixture.head);
    expect(adapter.evidence().branchUpdates).toBe(1);
    expect(adapter.evidence()).not.toHaveProperty("body");
    expect(JSON.stringify(adapter.evidence())).not.toContain(OFFLINE_GITHUB_CREDENTIAL);
  });

  it("rejects force updates and missing object targets", async () => {
    const adapter = remote();
    for (const body of [{ sha: fixture.head, force: true }, { sha: "a".repeat(40), force: false }, { sha: fixture.firstHead, force: false }]) {
      await expect(adapter.fetcher(uri("/git/refs/heads/pilot"), { method: "PATCH", headers, body: JSON.stringify(body) })).rejects.toThrow();
    }
    expect(adapter.head).toBe(fixture.head);
  });
});
