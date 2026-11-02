import { describe, expect, it } from "vitest";
import type { TimeseriesBucket } from "../../api/statistics";
import { computeAverageRates } from "../../components/Stats/components/pricing";
import {
  bucketKey,
  buildChart,
  buildHeatGrid,
  buildSlots,
  deltaOf,
  heatLevel,
  niceTicks,
  xLabelIndices,
} from "./statisticsView";

const ts = (iso: string) => Date.parse(iso) / 1000;
const row = (iso: string, perAgent: [string, number][], turns = 1): TimeseriesBucket => ({
  bucket_start: ts(iso),
  turns,
  tokens_in: perAgent.reduce((sum, [, n]) => sum + n, 0),
  tokens_cached: 0,
  tokens_out: 0,
  cost_total: 0,
  per_agent: perAgent.map(([agent, tokens]) => ({ agent, tokens, turns: 1, cost: 0 })),
});
const rates = computeAverageRates([]);

describe("bucketKey", () => {
  it("matches SQLite strftime on UTC", () => {
    expect(bucketKey(ts("2026-11-01T23:30:00Z"), "hourly")).toBe("2026-11-01 23");
    expect(bucketKey(ts("2026-11-01T23:30:00Z"), "daily")).toBe("2026-11-01");
    expect(bucketKey(ts("2026-11-01T23:30:00Z"), "monthly")).toBe("2026-11");
    // %W: Jan 1 2026 is a Thursday, so it sits in week 00 until Monday Jan 5.
    expect(bucketKey(ts("2026-01-04T12:00:00Z"), "weekly")).toBe("2026-00");
    expect(bucketKey(ts("2026-01-05T00:00:00Z"), "weekly")).toBe("2026-01");
    expect(bucketKey(ts("2026-11-01T12:00:00Z"), "weekly")).toBe("2026-43");
  });
});

describe("buildSlots", () => {
  it("zero-fills every bucket of the window and attaches the API rows", () => {
    const from = ts("2026-10-26T10:00:00Z");
    const to = ts("2026-11-01T10:00:00Z");
    const slots = buildSlots(from, to, "daily", [row("2026-11-01T00:20:00Z", [["codex", 500]])]);
    expect(slots).toHaveLength(7);
    expect(slots[0]).toMatchObject({ key: "2026-10-26", start: from });
    expect(slots[6].key).toBe("2026-11-01");
    expect(slots.filter((slot) => slot.data)).toHaveLength(1);
  });

  it("collapses days into week and month slots", () => {
    const from = ts("2026-10-01T00:00:00Z");
    const to = ts("2026-11-01T00:00:00Z");
    expect(buildSlots(from, to, "monthly", []).map((slot) => slot.key)).toEqual(["2026-10", "2026-11"]);
    expect(buildSlots(from, to, "weekly", []).length).toBe(5);
    expect(buildSlots(from, from + 24 * 3600 - 1, "hourly", [])).toHaveLength(24);
  });
});

describe("buildChart", () => {
  const slots = buildSlots(ts("2026-10-30T00:00:00Z"), ts("2026-11-01T12:00:00Z"), "daily", [
    row("2026-10-30T09:00:00Z", [["claude", 100], ["codex", 300]], 3),
    row("2026-11-01T09:00:00Z", [["codex", 50]]),
  ]);

  it("stacks Total per agent, heaviest agent first", () => {
    const chart = buildChart(slots, "total", "token", rates, false);
    expect(chart.series.map((s) => s.id)).toEqual(["codex", "claude"]);
    expect(chart.columns.map((c) => c.values)).toEqual([[300, 100], [0, 0], [50, 0]]);
    expect(chart.columns.map((c) => c.turns)).toEqual([3, 0, 1]);
    expect(chart.max).toBe(400);
    expect(chart.active).toBe(2);
  });

  it("draws a single layer for one token type", () => {
    const chart = buildChart(slots, "input", "token", rates, true);
    expect(chart.series).toHaveLength(1);
    expect(chart.columns.map((c) => c.total)).toEqual([400, 0, 50]);
  });

  it("keeps a bucket's total when it has no per-agent split", () => {
    const bare = { ...row("2026-10-31T09:00:00Z", [["x", 70]]), per_agent: [] };
    const chart = buildChart(buildSlots(ts("2026-10-31T00:00:00Z"), ts("2026-10-31T12:00:00Z"), "daily", [bare]), "total", "token", rates, false);
    expect(chart.series.map((s) => s.id)).toEqual(["_other"]);
    expect(chart.columns[0].total).toBe(70);
  });
});

describe("axes", () => {
  it("rounds the top tick up to a clean step", () => {
    expect(niceTicks(538_300)).toEqual([0, 200_000, 400_000, 600_000]);
    expect(niceTicks(400)).toEqual([0, 100, 200, 300, 400]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it("spaces x labels and keeps both ends", () => {
    expect(xLabelIndices(7, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const many = xLabelIndices(168, 7);
    expect(many[0]).toBe(0);
    expect(many[many.length - 1]).toBe(167);
    expect(many.length).toBeLessThanOrEqual(8);
  });
});

describe("heatmap", () => {
  it("reorders Sunday-first API rows to Monday-first and finds the peak", () => {
    const grid = buildHeatGrid([{ weekday: 0, hour: 0, turns: 4 }, { weekday: 1, hour: 9, turns: 12 }]);
    expect(grid.rows[6][0]).toBe(4);
    expect(grid.rows[0][9]).toBe(12);
    expect(grid.total).toBe(16);
    expect(grid.peak).toEqual({ day: "Mon", hour: 9, turns: 12 });
    expect(buildHeatGrid([]).peak).toBeNull();
  });

  it("uses the absolute intensity scale", () => {
    expect([0, 1, 4, 5, 14, 15, 29, 30].map(heatLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });
});

describe("deltaOf", () => {
  it("signs the change versus the previous window", () => {
    expect(deltaOf(118, 100)).toEqual({ text: "+18%", dir: 1 });
    expect(deltaOf(95, 100)).toEqual({ text: "−5.0%", dir: -1 });
    expect(deltaOf(5, 0)).toEqual({ text: "new", dir: 1 });
    expect(deltaOf(0, 0)).toBeNull();
    expect(deltaOf(5, undefined)).toBeNull();
  });
});
