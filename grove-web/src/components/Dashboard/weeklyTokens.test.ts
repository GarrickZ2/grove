import { describe, expect, it } from "vitest";
import type { StatisticsResponse, TimeseriesBucket } from "../../api/statistics";
import { summarizeWeeklyTokens } from "./weeklyTokens";

const day = (iso: string, perAgent: [string, number][]): TimeseriesBucket => ({
  bucket_start: Date.parse(`${iso}T00:00:00Z`) / 1000,
  turns: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0, cost_total: 0,
  per_agent: perAgent.map(([agent, tokens]) => ({ agent, tokens, turns: 1, cost: 0 })),
});

const stats = (timeseries: TimeseriesBucket[]) => ({ current: { timeseries }, previous: {} }) as unknown as StatisticsResponse;

describe("summarizeWeeklyTokens", () => {
  // Sunday 2026-11-01, late evening UTC.
  const now = new Date("2026-11-01T23:30:00Z");

  it("zero-fills a UTC-aligned week and finds the peak and top agent", () => {
    const summary = summarizeWeeklyTokens(stats([
      day("2026-10-27", [["claude", 100]]),
      day("2026-11-01", [["claude", 50], ["codex", 300]]),
      day("2026-10-20", [["codex", 999]]),
    ]), now);
    expect(summary.dayLabels).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(summary.series.map((d) => d.total)).toEqual([0, 100, 0, 0, 0, 0, 350]);
    expect(summary).toMatchObject({ total: 450, peak: 350, maxValue: 350, peakIdx: 6, topAgent: "codex" });
    expect(summary.agents).toEqual([{ agent: "codex", tokens: 300 }, { agent: "claude", tokens: 150 }]);
  });

  it("reports no activity without data", () => {
    expect(summarizeWeeklyTokens(null, now)).toMatchObject({ total: 0, peak: 1, maxValue: 0, peakIdx: -1, topAgent: "", agents: [] });
  });
});
