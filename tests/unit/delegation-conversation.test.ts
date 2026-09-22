import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ values: [] as Array<{ value: unknown }> }));
// Exercise the actual controller callbacks with an in-memory React state host.
// Effects (storage, background polling) are omitted; fetch boundaries are mocked.
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const entry = { value: typeof initial === "function" ? initial() : initial };
    state.values.push(entry);
    return [entry.value, (next: unknown) => { entry.value = typeof next === "function" ? next(entry.value) : next; }];
  },
  useRef: (value: unknown) => ({ current: value }),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}));
import { useWorkspaceController } from "@/hooks/use-workspace-controller";

const result = { requestId: "test", projectId: "test", prompt: "Build a page", summary: "Verified final response", dashboard: [],
  timeline: [{ id: "task", agentId: "frontend", title: "UI", input: "Build a page", dependsOn: [], status: "completed", output: "Inspected page" }],
  synthesis: { requirements: [], architecture: [], implementation: ["Inspected page"], quality: [], deployment: [], docs: [] } };
const chatText = () => state.values.flatMap(({value}) => Array.isArray(value) ? value : []).filter(v => v?.role === "assistant").map(v => v.content).join("\n");
beforeEach(() => { state.values = []; });
afterEach(() => { vi.unstubAllGlobals(); });
async function send(events: unknown[], separator = "\n\n") {
  const stream = new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}${separator}`));
    controller.close();
  } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ reply: "Starting specialist work", shouldDelegate: true, delegatePrompt: "Build a page" })))
    .mockResolvedValueOnce(new Response(stream)));
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React hooks are provided by the in-memory test host above.
  const controller = useWorkspaceController();
  await controller.sendChat("Build a page");
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
  return controller;
}
describe("delegation stays in the conversation", () => {
  it("continues from acknowledgement through tool activity to a final response", async () => {
    await send([{ type: "tool_progress", data: { agentId: "frontend", tool: "read_file", status: "completed" } }, { type: "done", result }]);
    await vi.waitFor(() => expect(chatText()).toContain("Verified final response"));
    expect(chatText()).toContain("Starting specialist work");
    expect(chatText()).toContain("Inspected page");
    expect(JSON.stringify(state.values)).toContain("tool:frontend read_file completed");
  });
  it("puts server errors in chat instead of stopping silently", async () => {
    await send([{ type: "error", message: "Provider unavailable" }]);
    await vi.waitFor(() => expect(chatText()).toContain("Provider unavailable"));
  });
  it("explains a stream that closes without completion", async () => {
    await send([]);
    await vi.waitFor(() => expect(chatText()).toContain("stopped before producing a final result"));
  });
  it("accepts CRLF-framed events", async () => {
    await send([{ type: "done", result }], "\r\n\r\n");
    await vi.waitFor(() => expect(chatText()).toContain("Verified final response"));
  });
});
