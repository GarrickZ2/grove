/**
 * View model for Orbit's Statistics page. Pure: turns a StatisticsResponse
 * into zero-filled chart columns, a Monday-first heatmap and KPI deltas.
 *
 * The backend groups `chat_token_usage` with SQLite strftime on UTC
 * (`%Y-%m-%d %H`, `%Y-%m-%d`, `%Y-%W`, `%Y-%m`), skips empty buckets and
 * stamps each one with its earliest turn. Keys are rebuilt here the same
 * way so every slot of the range gets a column, active or not.
 */

import type { Bucket, HeatmapCell, TimeseriesBucket } from "../../api/statistics";
import { agentColor } from "../../components/Stats/agentColors";
import { LOCALE } from "../ui/format";
import type { AverageRates } from "../../components/Stats/components/pricing";
import {
  agentOrderOf,
  agentStackValues,
  bucketValue,
  type MetricType,
  type Unit,
} from "../../components/Stats/statsModel";

export const METRIC_LABEL: Record<MetricType, string> = { total: "Total", input: "Input", cached: "Cached", output: "Output" };

const HOUR = 3600;
const DAY = 24 * HOUR;

const pad = (n: number) => String(n).padStart(2, "0");

/** strftime's `%W`: week of the year, Monday first; days before the first Monday are week 00. */
function mondayWeek(d: Date): number {
  const yday = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / (DAY * 1000));
  const mondayBased = (d.getUTCDay() + 6) % 7;
  return Math.floor((yday + 7 - mondayBased) / 7);
}

/** The backend's bucket key for a unix-seconds timestamp. */
export function bucketKey(ts: number, bucket: Bucket): string {
  const d = new Date(ts * 1000);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  switch (bucket) {
    case "hourly": return `${ymd} ${pad(d.getUTCHours())}`;
    case "daily": return ymd;
    case "weekly": return `${d.getUTCFullYear()}-${pad(mondayWeek(d))}`;
    case "monthly": return ymd.slice(0, 7);
  }
}

export interface Slot {
  key: string;
  /** First instant of the slot inside the range (unix seconds). */
  start: number;
  data?: TimeseriesBucket;
}

/** Every bucket slot from `from` to `to`, oldest first, with the API rows attached. */
export function buildSlots(from: number, to: number, bucket: Bucket, rows: TimeseriesBucket[]): Slot[] {
  if (to < from) return [];
  const byKey = new Map(rows.map((row) => [bucketKey(row.bucket_start, bucket), row]));
  const step = bucket === "hourly" ? HOUR : DAY;
  const slots: Slot[] = [];
  // Walk floor-aligned steps so each hour / day is visited once.
  const first = Math.floor(from / step) * step;
  for (let t = first; t <= to; t += step) {
    const at = Math.max(t, from);
    const key = bucketKey(at, bucket);
    if (slots.length && slots[slots.length - 1].key === key) continue;
    slots.push({ key, start: at, data: byKey.get(key) });
  }
  return slots;
}

export interface Series {
  id: string;
  label: string;
  color: string;
}

export interface Column {
  start: number;
  /** One value per series, in series order. */
  values: number[];
  total: number;
  turns: number;
}

export interface ChartModel {
  series: Series[];
  columns: Column[];
  /** Largest column total (0 without activity). */
  max: number;
  /** Columns with any activity. */
  active: number;
}

/** Token-type colors: fixed slots 1–3 of the validated categorical palette, per mode. */
export const TOKEN_COLORS: Record<"input" | "cached" | "output", { light: string; dark: string }> = {
  input: { light: "#2a78d6", dark: "#3987e5" },
  cached: { light: "#eb6834", dark: "#d95926" },
  output: { light: "#1baf7a", dark: "#199e70" },
};

export function tokenColor(kind: "input" | "cached" | "output", dark: boolean): string {
  return dark ? TOKEN_COLORS[kind].dark : TOKEN_COLORS[kind].light;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** An agent's brand color, lifted on dark surfaces where near-black marks would vanish. */
export function chartAgentColor(agent: string, dark: boolean): string {
  const base = agentColor(agent);
  if (dark && luminance(base) < 0.06) return `color-mix(in oklab, ${base} 40%, #ffffff)`;
  return base;
}

/**
 * Total stacks one layer per agent (heaviest at the base); input / cached /
 * output have no per-agent split in the timeseries, so they draw one layer.
 */
export function buildChart(
  slots: Slot[],
  metric: MetricType,
  unit: Unit,
  rates: AverageRates,
  dark: boolean,
  agentLabel: (agent: string) => string = (agent) => agent,
): ChartModel {
  const rows = slots.flatMap((slot) => (slot.data ? [slot.data] : []));
  let series: Series[];
  let valuesOf: (row: TimeseriesBucket) => number[];
  if (metric === "total") {
    const order = agentOrderOf(rows);
    series = order.map((agent) => ({ id: agent, label: agentLabel(agent), color: chartAgentColor(agent, dark) }));
    // A bucket without a per-agent split still has a total; keep it visible.
    valuesOf = (row) => (row.per_agent.length ? agentStackValues(row, order, unit, rates) : order.map(() => 0));
    if (rows.some((row) => !row.per_agent.length && bucketValue(row, metric, unit, rates) > 0)) {
      series = [...series, { id: "_other", label: "Other", color: dark ? "#8a8984" : "#a3a29d" }];
      const inner = valuesOf;
      valuesOf = (row) => [...inner(row), row.per_agent.length ? 0 : bucketValue(row, metric, unit, rates)];
    }
  } else {
    series = [{ id: metric, label: metric === "cached" ? "Cached" : metric === "input" ? "Input" : "Output", color: tokenColor(metric, dark) }];
    valuesOf = (row) => [bucketValue(row, metric, unit, rates)];
  }

  const columns = slots.map((slot) => {
    const values = slot.data ? valuesOf(slot.data) : series.map(() => 0);
    return { start: slot.start, values, total: values.reduce((sum, v) => sum + v, 0), turns: slot.data?.turns ?? 0 };
  });
  const max = Math.max(0, ...columns.map((column) => column.total));
  return { series, columns, max, active: columns.filter((column) => column.total > 0).length };
}

/** Clean y-axis ticks: 0 … top in `count` equal steps of 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag;
  const steps = Math.max(1, Math.ceil(max / step - 1e-9));
  return Array.from({ length: steps + 1 }, (_, i) => i * step);
}

/** Indices of up to `max` evenly spaced x-axis labels, always including both ends. */
export function xLabelIndices(n: number, max: number): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const stride = Math.ceil((n - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i += stride) out.push(i);
  // Drop the last regular tick when it would crowd the final label.
  if (out[out.length - 1] !== n - 1) {
    if (n - 1 - out[out.length - 1] < stride / 2) out.pop();
    out.push(n - 1);
  }
  return out;
}

const UTC = "UTC";

/** Axis (short) or tooltip (full) label for a slot; all in UTC like the buckets. */
export function slotLabel(start: number, bucket: Bucket, full: boolean, multiDay = false): string {
  const d = new Date(start * 1000);
  switch (bucket) {
    case "hourly":
      if (full) return `${d.toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric", timeZone: UTC })} · ${pad(d.getUTCHours())}:00 UTC`;
      // Over several days the date says more than the hour on an axis tick.
      return multiDay ? d.toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: UTC }) : `${pad(d.getUTCHours())}:00`;
    case "daily":
      return full
        ? d.toLocaleDateString(LOCALE, { weekday: "long", month: "short", day: "numeric", timeZone: UTC })
        : d.toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: UTC });
    case "weekly":
      return full
        ? `Week of ${d.toLocaleDateString(LOCALE, { month: "short", day: "numeric", year: "numeric", timeZone: UTC })}`
        : d.toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: UTC });
    case "monthly":
      return d.toLocaleDateString(LOCALE, full ? { month: "long", year: "numeric", timeZone: UTC } : { month: "short", timeZone: UTC });
  }
}

// ── Heatmap ─────────────────────────────────────────────────────────────

/** Rows Monday-first; the API's weekday is 0 = Sunday. */
export const HEAT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Absolute intensity scale, kept from the Workbench heatmap: a busy hour
 * sees 10–30 turns, and relative scaling made 4 turns look like a peak.
 */
export function heatLevel(turns: number): 0 | 1 | 2 | 3 | 4 {
  if (turns <= 0) return 0;
  if (turns < 5) return 1;
  if (turns < 15) return 2;
  if (turns < 30) return 3;
  return 4;
}

export interface HeatGrid {
  /** 7 × 24 turn counts, Monday-first rows. */
  rows: number[][];
  total: number;
  peak: { day: string; hour: number; turns: number } | null;
}

export function buildHeatGrid(cells: HeatmapCell[]): HeatGrid {
  const rows = HEAT_DAYS.map(() => Array.from({ length: 24 }, () => 0));
  let total = 0;
  let peak: HeatGrid["peak"] = null;
  for (const cell of cells) {
    if (cell.hour < 0 || cell.hour > 23 || cell.weekday < 0 || cell.weekday > 6) continue;
    const row = (cell.weekday + 6) % 7;
    rows[row][cell.hour] += cell.turns;
    total += cell.turns;
  }
  rows.forEach((hours, row) => hours.forEach((turns, hour) => {
    if (turns > 0 && (!peak || turns > peak.turns)) peak = { day: HEAT_DAYS[row], hour, turns };
  }));
  return { rows, total, peak };
}

// ── KPIs ────────────────────────────────────────────────────────────────

export interface Delta {
  text: string;
  dir: 1 | -1 | 0;
}

/** Signed change versus the previous window; null when there's nothing to compare. */
export function deltaOf(current: number | undefined, previous: number | undefined): Delta | null {
  if (current == null || previous == null) return null;
  if (previous === 0) return current === 0 ? null : { text: "new", dir: 1 };
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return { text: "±0%", dir: 0 };
  return { text: `${pct > 0 ? "+" : "−"}${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%`, dir: pct > 0 ? 1 : -1 };
}

/** Per-hour for a 24h window, per-day otherwise: the unit and how many fit in the window. */
export function rateLabel(rangeSecs: number): { per: string; divisor: number } {
  return rangeSecs <= DAY ? { per: "hour", divisor: rangeSecs / HOUR } : { per: "day", divisor: rangeSecs / DAY };
}
