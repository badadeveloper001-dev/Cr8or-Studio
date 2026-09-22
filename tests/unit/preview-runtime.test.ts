import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ command: vi.fn(), session: vi.fn(), signed: vi.fn(), sandbox: vi.fn() }));
vi.mock("@/lib/security/authorization", () => ({ authorizeRoute: async () => ({ ok: true, session: { userId: "test", role: "owner" } }) }));
vi.mock("@/lib/observability/sli", () => ({ withRouteMetrics: (_: unknown, fn: (request: unknown, context: unknown) => unknown) => (request: unknown) => fn(request, { requestId: "test" }) }));
vi.mock("@/lib/workspace/cloud-projects", () => ({ findCloudProject: async () => ({ runtimeType: "cloud", providerWorkspaceId: "test" }) }));
vi.mock("@/lib/workspace/providers/daytona", () => ({ DaytonaProvider: class { getSandbox = mocks.sandbox; } }));
import { POST } from "@/app/api/workspaces/[projectId]/preview/route";
import { CLOUD_REPOSITORY_ROOT } from "@/lib/workspace/cloud-path";

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubEnv("DAYTONA_API_KEY", "test");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("preview ready")));
  mocks.sandbox.mockResolvedValue({ state: "started", process: { executeCommand: mocks.command, createSession: vi.fn(), deleteSession: vi.fn(), executeSessionCommand: mocks.session },
    fs: { downloadFile: async () => Buffer.from(JSON.stringify({ scripts: { dev: "next dev" } })) }, getSignedPreviewUrl: mocks.signed });
  mocks.command.mockImplementation(async (command: string) => ({ result: command.includes("curl") ? "200" : command.includes("pgrep") ? "STOPPED" : "", exitCode: 0 }));
  mocks.session.mockResolvedValue({ cmdId: "test" });
  mocks.signed.mockResolvedValue({ url: "https://preview.example.test" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function start() {
  const pending = POST(new NextRequest("http://localhost/api/workspaces/test/preview", { method: "POST", body: JSON.stringify({ action: "start" }) }), { params: Promise.resolve({ projectId: "test" }) });
  await vi.runAllTimersAsync();
  return pending;
}
describe("preview runtime", () => {
  it("launches the asynchronous session from the cloned repository", async () => {
    expect((await start()).status).toBe(200);
    expect(mocks.session.mock.calls[0][1].command).toContain(`cd '${CLOUD_REPOSITORY_ROOT}' &&`);
  });
  it("checks HTTP readiness even if a process already exists", async () => {
    mocks.command.mockImplementation(async (command: string) => ({ result: command.includes("pgrep") ? "RUNNING" : "000", exitCode: 0 }));
    expect((await start()).status).toBe(502);
    expect(mocks.signed).not.toHaveBeenCalled();
  });
  it("does not mistake the pgrep shell itself for the dev server", async () => {
    await start();
    const command = mocks.command.mock.calls.find(([cmd]) => cmd.includes("pgrep"))?.[0];
    expect(command).toContain("[n]ext dev");
  });
  it("does not report success when the signed URL fails", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("Unavailable", { status: 502 }));
    expect((await start()).status).toBe(502);
  });
  it("keeps fallback and readiness commands in the repository", async () => {
    mocks.session.mockRejectedValue(new Error("session unavailable"));
    expect((await start()).status).toBe(200);
    for (const call of mocks.command.mock.calls) expect(call[1]).toBe(CLOUD_REPOSITORY_ROOT);
    expect(mocks.command.mock.calls.some(([command]) => command.includes("nohup"))).toBe(true);
  });
});
