import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation, AutomationRun } from "../../api/automations";
import { listAutomationRuns, listAutomations, triggerAutomation, updateAutomation } from "../../api/automations";
import { useAutomationRuns, useProjectAutomations } from "./useAutomations";

vi.mock("../../api/automations", () => ({
  listAutomations: vi.fn(),
  listAutomationRuns: vi.fn(),
  updateAutomation: vi.fn(),
  triggerAutomation: vi.fn(),
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  cancelAutomationRun: vi.fn(),
}));

const row = {
  id: "a1", project: "p", name: "Standup", enabled: true, handler_key: "builtin.task_prompt",
  agent_config: { source: "default" }, task_mode: "existing", task_id: "_local", session_mode: "new",
  prompt: "x", schedule_cron: "0 9 * * *", created_at: 0, updated_at: 0,
} as Automation;
const run = (status: string) => ({ id: "r1", automation_id: "a1", status, triggered_at: 1 }) as AutomationRun;

let root: Root;
let host: HTMLDivElement;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  root = createRoot(host);
  vi.mocked(listAutomations).mockResolvedValue([row]);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useProjectAutomations", () => {
  it("flips optimistically, sends the full row, and reverts when the PUT fails", async () => {
    let api!: ReturnType<typeof useProjectAutomations>;
    function Probe() { api = useProjectAutomations("p"); return null; }
    act(() => root.render(<Probe />));
    await flush();
    expect(api.automations[0].enabled).toBe(true);

    let resolvePut!: (v: Automation) => void;
    vi.mocked(updateAutomation).mockReturnValueOnce(new Promise((r) => { resolvePut = r; }));
    let ok!: Promise<{ ok: boolean }>;
    act(() => { ok = api.toggleEnabled(api.automations[0]); });
    expect(api.automations[0].enabled).toBe(false);
    expect(api.togglingId).toBe("a1");
    expect(vi.mocked(updateAutomation).mock.calls[0][2]).toMatchObject({ name: "Standup", enabled: false, schedule_cron: "0 9 * * *" });
    await act(async () => { resolvePut({ ...row, enabled: false }); expect((await ok).ok).toBe(true); });

    vi.mocked(updateAutomation).mockRejectedValueOnce(new Error("nope"));
    await act(async () => { expect(await api.patch(api.automations[0], { name: "Renamed" })).toEqual({ ok: false, error: "nope" }); });
    await flush();
    expect(api.automations[0].name).toBe("Standup");
  });

  it("bumps the runs tick after a manual run", async () => {
    vi.mocked(triggerAutomation).mockResolvedValue({ run_id: "r1", status: "queued" });
    let api!: ReturnType<typeof useProjectAutomations>;
    function Probe() { api = useProjectAutomations("p"); return null; }
    act(() => root.render(<Probe />));
    await flush();
    await act(async () => { expect(await api.trigger("a1")).toBe(true); });
    expect(api.runsRefreshTick).toBe(1);
  });
});

describe("useAutomationRuns", () => {
  it("polls while a run is in flight and reports when it settles", async () => {
    vi.useFakeTimers();
    vi.mocked(listAutomationRuns).mockResolvedValueOnce([run("running")]).mockResolvedValue([run("success")]);
    const onSettle = vi.fn();
    let state!: ReturnType<typeof useAutomationRuns>;
    function Probe() { state = useAutomationRuns("p", "a1", 0, { onSettle }); return null; }
    act(() => root.render(<Probe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(state.runs?.[0].status).toBe("running");
    expect(onSettle).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(state.runs?.[0].status).toBe("success");
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});
