import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalStatistics, getProjectStatistics, type StatisticsResponse } from "../../api/statistics";
import { kpiValue, valueTop } from "./statsModel";
import { computeAverageRates } from "./components/pricing";
import { useStatisticsState, type StatisticsState } from "./useStatisticsState";

vi.mock("../../api/statistics", () => ({ getGlobalStatistics: vi.fn(), getProjectStatistics: vi.fn() }));

const kpi = { turns: 2, tokens_total: 300, tokens_in: 200, tokens_out: 60, tokens_cached: 40, agent_compute_secs: 10, avg_tokens_per_turn: 150, avg_duration_secs: 5, p50_duration_secs: 5, cost_total: 0 };
const response = (turns: number): StatisticsResponse => ({
  current: { kpi: { ...kpi, turns }, timeseries: [], agent_share: [], models: [], top: [], heatmap: [] },
  previous: { kpi },
});

let root: Root;
let host: HTMLDivElement;
let state: StatisticsState;

function Probe({ projectId, onState }: { projectId?: string; onState: (next: StatisticsState) => void }) {
  onState(useStatisticsState(projectId));
  return null;
}

async function render(projectId?: string) {
  await act(async () => root.render(<Probe projectId={projectId} onState={(next) => { state = next; }} />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  root = createRoot(host);
  vi.mocked(getGlobalStatistics).mockResolvedValue(response(1));
  vi.mocked(getProjectStatistics).mockResolvedValue(response(2));
});

afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
});

describe("useStatisticsState", () => {
  it("starts in project scope with a project and records the fetched window", async () => {
    await render("p1");
    expect(state.scope).toBe("project");
    expect(getProjectStatistics).toHaveBeenCalledWith("p1", expect.objectContaining({ bucket: "daily" }));
    expect(state.data?.current.kpi.turns).toBe(2);
    expect(state.dataWindow!.to - state.dataWindow!.from).toBe(7 * 24 * 3600);
  });

  it("falls back to global without a project", async () => {
    await render();
    expect(state.scope).toBe("global");
    expect(getGlobalStatistics).toHaveBeenCalled();
    expect(getProjectStatistics).not.toHaveBeenCalled();
  });

  it("coerces an incompatible bucket when the range changes", async () => {
    await render();
    await act(async () => state.setRange("24h"));
    expect(state.bucket).toBe("hourly");
    await act(async () => state.setRange("1y"));
    expect(state.bucket).toBe("monthly");
    expect(state.allowedBuckets).toEqual(["daily", "weekly", "monthly"]);
  });

  it("drops a slow earlier response once a newer one landed", async () => {
    let resolveSlow!: (value: StatisticsResponse) => void;
    vi.mocked(getGlobalStatistics)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }))
      .mockResolvedValueOnce(response(9));
    await render();
    await act(async () => state.setRange("30d"));
    expect(state.data?.current.kpi.turns).toBe(9);
    await act(async () => resolveSlow(response(1)));
    expect(state.data?.current.kpi.turns).toBe(9);
    expect(state.dataWindow!.to - state.dataWindow!.from).toBe(30 * 24 * 3600);
  });

  it("clears data and reports the error when a fetch fails", async () => {
    vi.mocked(getGlobalStatistics).mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(state.error).toBe("offline");
    expect(state.data).toBeNull();
    expect(state.loading).toBe(false);
  });
});

describe("statsModel values", () => {
  const rates = computeAverageRates([]);
  it("reads tokens per metric and prefers reported cost", () => {
    expect(kpiValue(kpi, "cached", "token", rates)).toBe(40);
    expect(kpiValue({ ...kpi, cost_total: 1.5 }, "total", "cost", rates)).toBe(1.5);
    expect(kpiValue(undefined, "total", "token", rates)).toBe(0);
  });

  it("ranks top rows by the metric", () => {
    const item = (id: string, input: number, output: number) => ({ id, name: id, turns: 1, tokens: input + output, input_tokens: input, cached_tokens: 0, output_tokens: output, agent_split: [], cost: 0 });
    expect(valueTop([item("a", 10, 90), item("b", 50, 5)], "input", "token", rates).map((row) => row.id)).toEqual(["b", "a"]);
    expect(valueTop([item("a", 10, 90), item("b", 50, 5)], "total", "token", rates).map((row) => row.id)).toEqual(["a", "b"]);
  });
});
