/**
 * 5 KPI cards across the top of the Statistics page. Each card shows the
 * current period's value plus a Δ delta versus the previous period of equal
 * length. Δ color is green when "more activity" (turns/tokens up), neutral
 * for nominal metrics (avg tokens/turn, avg duration) — we don't editorialize
 * "good" vs "bad", just show the direction.
 */

import {
  RefreshCcw,
  Infinity as InfinityIcon,
  Clock,
  Hash,
  Zap,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

import type { KpiData } from "../../../api/statistics";
import {
  formatTokens,
  formatDuration,
  formatNumber,
  formatCost,
  computeDelta,
} from "../formatters";
import type { MetricType, Unit } from "../ProjectStatsPage";
import type { AverageRates } from "./pricing";

interface KpiRowProps {
  current?: KpiData;
  previous?: KpiData;
  metricType: MetricType;
  unit: Unit;
  averageRates: AverageRates;
}

export function KpiRow({
  current,
  previous,
  metricType,
  unit,
  averageRates,
}: KpiRowProps) {
  const getValue = (k: KpiData | undefined) => {
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
      } else {
        switch (metricType) {
          case "input": return cost_in_est;
          case "cached": return cost_cached_est;
          case "output": return cost_out_est;
        }
      }
    } else {
      switch (metricType) {
        case "total": return k.tokens_total;
        case "input": return k.tokens_in;
        case "cached": return k.tokens_cached;
        case "output": return k.tokens_out;
      }
    }
  };

  const currVal = getValue(current);
  const prevVal = getValue(previous);

  const turnsCurrent = current?.turns ?? 0;
  const turnsPrevious = previous?.turns ?? 0;

  const avgCurr = turnsCurrent > 0 ? currVal / turnsCurrent : 0;
  const avgPrev = turnsPrevious > 0 ? prevVal / turnsPrevious : 0;

  const valueFmt = unit === "cost" ? formatCost : formatTokens;
  
  const metricLabels: Record<MetricType, string> = {
    total: "Total",
    input: "Input",
    cached: "Cache",
    output: "Output",
  };

  const labelPrefix = metricLabels[metricType];
  const tokensLabel = unit === "cost" ? `${labelPrefix} Cost` : `${labelPrefix} Tokens`;
  const avgLabel = unit === "cost" ? `Avg Cost / Turn` : `Avg Tokens / Turn`;

  return (
    <div className="grid grid-cols-5 gap-3 shrink-0">
      <KpiCard
        icon={<RefreshCcw className="w-3.5 h-3.5" />}
        label="Prompt Turns"
        value={formatNumber(current?.turns ?? 0)}
        delta={computeDelta(current?.turns, previous?.turns)}
      />
      <KpiCard
        icon={<InfinityIcon className="w-3.5 h-3.5" />}
        label={tokensLabel}
        value={valueFmt(currVal)}
        delta={computeDelta(currVal, prevVal)}
        extra={current ? <TokenSplitBar kpi={current} unit={unit} averageRates={averageRates} /> : undefined}
      />
      <KpiCard
        icon={<Clock className="w-3.5 h-3.5" />}
        label="Total Turn Duration"
        value={formatDuration(current?.agent_compute_secs ?? 0)}
        sub="sum of end−start (overlapping turns counted twice)"
        delta={computeDelta(
          current?.agent_compute_secs,
          previous?.agent_compute_secs,
        )}
      />
      <KpiCard
        icon={<Hash className="w-3.5 h-3.5" />}
        label={avgLabel}
        value={valueFmt(avgCurr)}
        delta={computeDelta(avgCurr, avgPrev)}
      />
      <KpiCard
        icon={<Zap className="w-3.5 h-3.5" />}
        label="Avg Duration / Turn"
        value={formatDuration(current?.avg_duration_secs ?? 0, true)}
        sub={
          current
            ? `p50 ${formatDuration(current.p50_duration_secs, true)}`
            : undefined
        }
        delta={computeDelta(
          current?.avg_duration_secs,
          previous?.avg_duration_secs,
        )}
      />
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  sub,
  delta,
  extra,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  delta: { pct: number | null; direction: 1 | -1 | 0 };
  extra?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        <span className="w-5 h-5 rounded-md bg-[color-mix(in_srgb,var(--color-highlight)_15%,transparent)] inline-flex items-center justify-center text-[var(--color-highlight)]">
          {icon}
        </span>
        {label}
      </div>
      <div className="text-2xl font-bold text-[var(--color-text)] tabular-nums leading-tight">
        {value}
      </div>
      <DeltaLine delta={delta} sub={sub} />
      {extra}
    </div>
  );
}

// Token type palette — used by both the KPI bar and ActivityOverTime stacks.
// Colors are theme-aware by leaning on grove's existing semantic tokens
// where possible, and fall back to fixed hex when the semantic palette
// doesn't have an obvious slot.
export const TOKEN_TYPE_COLORS = {
  input: "var(--color-info, #3b82f6)", // bluish — fresh input
  cached: "var(--color-text-muted)", // muted — replayed from cache, cheap
  output: "var(--color-highlight)", // accent — actual generated work
} as const;

function TokenSplitBar({
  kpi,
  unit,
  averageRates,
}: {
  kpi: KpiData;
  unit: Unit;
  averageRates: AverageRates;
}) {
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
      cost_in = kpi.cost_total;
    }
  }

  const v_in = unit === "cost" ? cost_in : kpi.tokens_in;
  const v_cached = unit === "cost" ? cost_cached : kpi.tokens_cached;
  const v_out = unit === "cost" ? cost_out : kpi.tokens_out;

  const total = v_in + v_cached + v_out;
  if (total === 0) return null;

  const ipct = (v_in / total) * 100;
  const cpct = (v_cached / total) * 100;
  const opct = (v_out / total) * 100;

  const fmt = unit === "cost" ? formatCost : formatTokens;
  const unitName = unit === "cost" ? "" : " tokens";

  return (
    <div
      className="flex h-1.5 w-full rounded-sm overflow-hidden"
      title={`${fmt(v_in)}${unitName} in · ${fmt(v_cached)}${unitName} cached · ${fmt(v_out)}${unitName} out`}
    >
      <div
        style={{ width: `${ipct}%`, backgroundColor: TOKEN_TYPE_COLORS.input }}
      />
      <div
        style={{ width: `${cpct}%`, backgroundColor: TOKEN_TYPE_COLORS.cached }}
      />
      <div
        style={{ width: `${opct}%`, backgroundColor: TOKEN_TYPE_COLORS.output }}
      />
    </div>
  );
}

function DeltaLine({
  delta,
  sub,
}: {
  delta: { pct: number | null; direction: 1 | -1 | 0 };
  sub?: string;
}) {
  const Icon =
    delta.direction === 1
      ? TrendingUp
      : delta.direction === -1
        ? TrendingDown
        : Minus;
  const color =
    delta.direction === 1
      ? "var(--color-success)"
      : delta.direction === -1
        ? "var(--color-error)"
        : "var(--color-text-muted)";
  const pctText =
    delta.pct == null
      ? "—"
      : delta.pct === Infinity
        ? "new"
        : `${Math.abs(delta.pct).toFixed(1)}%`;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] tabular-nums">
      <Icon className="w-3 h-3" style={{ color }} />
      <span style={{ color }} className="font-semibold">
        {pctText}
      </span>
      <span className="truncate">{sub ?? "vs prev period"}</span>
    </div>
  );
}
