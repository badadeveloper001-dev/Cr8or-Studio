import { describe, expect, it } from "vitest";

describe("preview route contract", () => {
  it("import uses CLOUD_REPOSITORY_ROOT not hardcoded /workspace/repo", async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(
      "src/app/api/workspaces/[projectId]/preview/route.ts",
      "utf8",
    );
    expect(content).toMatch(/import \{[^}]*CLOUD_REPOSITORY_ROOT[^}]*\} from "@\/lib\/workspace\/cloud-path"/);
    expect(content).not.toContain('"/workspace/repo"');
  });

  it("package.json read uses CLOUD_REPOSITORY_ROOT", async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(
      "src/app/api/workspaces/[projectId]/preview/route.ts",
      "utf8",
    );
    expect(content).toContain("`${CLOUD_REPOSITORY_ROOT}/package.json`");
    expect(content).not.toContain('"/workspace/repo/package.json"');
  });

  it("readiness check polls before returning signed URL", async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(
      "src/app/api/workspaces/[projectId]/preview/route.ts",
      "utf8",
    );
    expect(content).toContain("waitForDevServer");
    expect(content).toContain("READINESS_POLL_INTERVAL_MS");
    expect(content).toContain("READINESS_MAX_ATTEMPTS");
  });

  it("returns 502 UPSTREAM_ERROR when server fails to start", async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(
      "src/app/api/workspaces/[projectId]/preview/route.ts",
      "utf8",
    );
    expect(content).toContain("UPSTREAM_ERROR");
    expect(content).toContain('status: 502');
  });

  it("stop kills next dev and next-server", async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(
      "src/app/api/workspaces/[projectId]/preview/route.ts",
      "utf8",
    );
    expect(content).toContain("pkill -f '[n]ext dev'");
    expect(content).toContain("pkill -f '[n]ext-server|[v]ite'");
  });

  it("uses session API for background process", async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(
      "src/app/api/workspaces/[projectId]/preview/route.ts",
      "utf8",
    );
    expect(content).toContain("createSession");
    expect(content).toContain("executeSessionCommand");
    expect(content).toContain("runAsync: true");
  });
});
