/**
 * Statistics value model shared by the Workbench page and Orbit's
 * Statistics page: range/bucket presets and the token-or-cost value of
 * each API row under a metric. Everything here is pure.
 *
 * Cost: agents that report `cost_amount` are used as-is; everything else
 * is estimated from the pricing table (see ./components/pricing.ts).
 */

import type {
  Bucket,
  KpiData,
  ModelItem,
  TimeseriesBucket,
  TopItem,
} from "../../api/statistics";
import { getModelRates, type AverageRates } from "./components/pricing";

export type MetricType = "total" | "input" | "cached" | "output";
export type Unit = "token" | "cost";
export type Scope = "global" | "project";

// ── Range & bucket presets ──────────────────────────────────────────────

export type RangeId = "24h" | "7d" | "30d" | "90d" | "1y";

export const RANGE_SECS: Record<RangeId, number> = {
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
  "90d": 90 * 24 * 3600,
  "1y": 365 * 24 * 3600,
};

export const RANGE_OPTIONS: { id: RangeId; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "1y", label: "1y" },
];

export const BUCKET_OPTIONS: { id: Bucket; label: string }[] = [
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

/**
 * Bucket compatibility matrix:
 *   - 24h: only Hourly makes sense (Daily would be 1 point)
 *   - 7d:  Hourly produces 168 buckets — fine. Daily preferred. Weekly/Monthly too coarse.
 *   - 30d: Hourly = 720 buckets, allowed but heavy. Daily/Weekly are sweet spot.
 *   - 90d: Hourly disabled (renders too many points). Daily/Weekly/Monthly OK.
 *   - 1y:  Hourly disabled. Daily allowed but dense. Weekly/Monthly preferred.
 */
export const ALLOWED_BUCKETS: Record<RangeId, Bucket[]> = {
  "24h": ["hourly"],
  "7d": ["hourly", "daily"],
  "30d": ["hourly", "daily", "weekly"],
  "90d": ["daily", "weekly", "monthly"],
  "1y": ["daily", "weekly", "monthly"],
};

export const DEFAULT_BUCKET: Record<RangeId, Bucket> = {
  "24h": "hourly",
  "7d": "daily",
  "30d": "daily",
  "90d": "weekly",
  "1y": "monthly",
};

// ── Values ──────────────────────────────────────────────────────────────

/** A period's KPI value for the metric, in tokens or (estimated) cost. */
export function kpiValue(
  k: KpiData | undefined,
  metricType: MetricType,
  unit: Unit,
  averageRates: AverageRates,
): number {
  if (!k) return 0;
  if (unit === "cost") {
    const cost_in_est = k.tokens_in * averageRates.input;
    const cost_cached_est = k.tokens_cached * averageRates.cached;
    const cost_out_est = k.tokens_out * averageRates.output;
    const cost_total_est = cost_in_est + cost_cached_est + cost_out_est;
    const actual_cost = k.cost_total > 0 ? k.cost_total : cost_total_est;

    if (metricType === "total") return actual_cost;

    // Distribute actual_cost proportionally if we have it
    if (k.cost_total > 0 && cost_total_est > 0) {
      const ratio = k.cost_total / cost_total_est;
      switch (metricType) {
        case "input": return cost_in_est * ratio;
        case "cached": return cost_cached_est * ratio;
        case "output": return cost_out_est * ratio;
      }
    } else if (k.cost_total > 0) {
      // cost_total > 0 but no token-derived split — match TokenSplitBar's
      // three-way fallback so the KPI card sums to cost_total instead of
      // showing all components as $0.
      const third = k.cost_total / 3;
      switch (metricType) {
        case "input":
        case "cached":
        case "output": return third;
      }
    } else {
      switch (metricType) {
        case "input": return cost_in_est;
        case "cached": return cost_cached_est;
        case "output": return cost_out_est;
      }
    }
    return 0;
  } else {
    switch (metricType) {
      case "total": return k.tokens_total;
      case "input": return k.tokens_in;
      case "cached": return k.tokens_cached;
      case "output": return k.tokens_out;
    }
    return 0;
  }
}

/** Input / cached / output parts of a period, in tokens or (estimated) cost. */
export function kpiSplit(
  kpi: KpiData,
  unit: Unit,
  averageRates: AverageRates,
): { input: number; cached: number; output: number } {
  let cost_in = kpi.tokens_in * averageRates.input;
  let cost_cached = kpi.tokens_cached * averageRates.cached;
  let cost_out = kpi.tokens_out * averageRates.output;

  if (unit === "cost" && kpi.cost_total > 0) {
    const est_total = cost_in + cost_cached + cost_out;
    if (est_total > 0) {
      const ratio = kpi.cost_total / est_total;
      cost_in *= ratio;
      cost_cached *= ratio;
      cost_out *= ratio;
    } else {
      // No token-derived split available — distribute evenly across the three
      // segments so the bar doesn't render 100% "input" color. Matches
      // bucketValue's fallback for the same shape.
      const third = kpi.cost_total / 3;
      cost_in = third;
      cost_cached = third;
      cost_out = third;
    }
  }

  return {
    input: unit === "cost" ? cost_in : kpi.tokens_in,
    cached: unit === "cost" ? cost_cached : kpi.tokens_cached,
    output: unit === "cost" ? cost_out : kpi.tokens_out,
  };
}

/** A timeseries bucket's value for the metric (single layer, all agents). */
export function bucketValue(b: TimeseriesBucket, m: MetricType, u: Unit, r: AverageRates): number {
  let cost_in = b.tokens_in * r.input;
  let cost_cached = b.tokens_cached * r.cached;
  let cost_out = b.tokens_out * r.output;

  if (u === "cost" && b.cost_total > 0) {
    const est_total = cost_in + cost_cached + cost_out;
    if (est_total > 0) {
      const ratio = b.cost_total / est_total;
      cost_in *= ratio;
      cost_cached *= ratio;
      cost_out *= ratio;
    } else {
      // No token-derived split available — distribute evenly across the three
      // segments so input/cached/output charts don't show the whole cost as
      // "input only" (which was visually misleading).
      const third = b.cost_total / 3;
      cost_in = third;
      cost_cached = third;
      cost_out = third;
    }
  }

  if (u === "cost") {
    switch (m) {
      case "total":
        return b.cost_total > 0 ? b.cost_total : cost_in + cost_cached + cost_out;
      case "input":
        return cost_in;
      case "cached":
        return cost_cached;
      case "output":
        return cost_out;
    }
    return 0;
  } else {
    switch (m) {
      case "total":
        return b.tokens_in + b.tokens_cached + b.tokens_out;
      case "input":
        return b.tokens_in;
      case "cached":
        return b.tokens_cached;
      case "output":
        return b.tokens_out;
    }
    return 0;
  }
}

/** Agents ordered by total tokens across the series, heaviest first. */
export function agentOrderOf(buckets: TimeseriesBucket[]): string[] {
  const totals = new Map<string, number>();
  for (const b of buckets) {
    for (const a of b.per_agent) {
      totals.set(a.agent, (totals.get(a.agent) ?? 0) + a.tokens);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

/** Per-agent values of one bucket, in `agentOrder`, for the Total metric. */
export function agentStackValues(
  b: TimeseriesBucket,
  agentOrder: string[],
  unit: Unit,
  averageRates: AverageRates,
): number[] {
  const map = new Map(b.per_agent.map((a) => [a.agent, a]));

  // For cost mode, build avg_cost_per_token from ONLY the non-reporting
  // agents' subset of total cost & tokens. Otherwise reporting agents'
  // cost gets double-counted: their own cost shows directly AND their
  // tokens contribute to the shared avg that non-reporting agents
  // inherit, causing the stack to overshoot bucket.cost_total.
  const reportingCost = b.per_agent
    .filter((a) => (a.cost ?? 0) > 0)
    .reduce((s, a) => s + (a.cost ?? 0), 0);
  // Sum tokens DIRECTLY from the non-reporting subset rather than
  // deriving via (bucket_total - reporting). The two domains don't
  // necessarily share a denominator (backend can produce per_agent
  // totals that drift from bucket.tokens_in/cached/out), and the
  // subtraction-based approach mis-allocates avg_cost_per_token when
  // they diverge.
  const nonReportingTokens = b.per_agent
    .filter((a) => (a.cost ?? 0) === 0)
    .reduce((s, a) => s + a.tokens, 0);
  const cost_in = b.tokens_in * averageRates.input;
  const cost_cached = b.tokens_cached * averageRates.cached;
  const cost_out = b.tokens_out * averageRates.output;
  const total_cost = b.cost_total > 0 ? b.cost_total : cost_in + cost_cached + cost_out;
  const nonReportingCost = Math.max(0, total_cost - reportingCost);
  const avg_cost_per_token = nonReportingTokens > 0 ? nonReportingCost / nonReportingTokens : 0;

  return agentOrder.map((agent) => {
    const agentBucket = map.get(agent);
    const agentTokens = agentBucket?.tokens ?? 0;
    const agentCost = agentBucket?.cost ?? 0;
    return unit === "cost"
      ? (agentCost > 0 ? agentCost : agentTokens * avg_cost_per_token)
      : agentTokens;
  });
}

export interface ValuedRow {
  v_total: number;
  v_in: number;
  v_cached: number;
  v_out: number;
  /** The metric's value — what the row is ranked and drawn by. */
  displayValue: number;
}

function valued(
  tokens: { tokens: number; input_tokens: number; cached_tokens: number; output_tokens: number; cost: number },
  rates: { input: number; cached: number; output: number },
  metricType: MetricType,
  unit: Unit,
): ValuedRow {
  let cost_in = tokens.input_tokens * rates.input;
  let cost_cached = tokens.cached_tokens * rates.cached;
  let cost_out = tokens.output_tokens * rates.output;
  const cost_total = tokens.cost > 0 ? tokens.cost : cost_in + cost_cached + cost_out;

  if (tokens.cost > 0) {
    const est_total = cost_in + cost_cached + cost_out;
    if (est_total > 0) {
      const ratio = tokens.cost / est_total;
      cost_in *= ratio;
      cost_cached *= ratio;
      cost_out *= ratio;
    } else {
      cost_in = tokens.cost;
    }
  }

  const v_total = unit === "cost" ? cost_total : tokens.tokens;
  const v_in = unit === "cost" ? cost_in : tokens.input_tokens;
  const v_cached = unit === "cost" ? cost_cached : tokens.cached_tokens;
  const v_out = unit === "cost" ? cost_out : tokens.output_tokens;

  let displayValue = v_total;
  if (metricType === "input") displayValue = v_in;
  else if (metricType === "cached") displayValue = v_cached;
  else if (metricType === "output") displayValue = v_out;

  return { v_total, v_in, v_cached, v_out, displayValue };
}

/** Models valued at their own rates, largest first. */
export function valueModels(items: ModelItem[], metricType: MetricType, unit: Unit): (ModelItem & ValuedRow)[] {
  const enriched = items.map((it) => ({ ...it, ...valued(it, getModelRates(it.model || it.agent), metricType, unit) }));
  return enriched.sort((a, b) => b.displayValue - a.displayValue);
}

/** Top projects / tasks valued at the period's average rates, largest first. */
export function valueTop(items: TopItem[], metricType: MetricType, unit: Unit, averageRates: AverageRates): (TopItem & ValuedRow)[] {
  const enriched = items.map((it) => ({ ...it, ...valued(it, averageRates, metricType, unit) }));
  return enriched.sort((a, b) => b.displayValue - a.displayValue);
}
