/**
 * Top entities — projects in Global scope, tasks in Project scope.
 * Each row shows a 3-segment input / cached / output bar in three shades
 * of the row's *dominant agent* color.
 */

import type { TopItem } from "../../../api/statistics";
import { agentShades } from "../agentColors";
import { formatTokens, formatNumber, formatCost } from "../formatters";
import type { MetricType, Unit } from "../ProjectStatsPage";
import type { AverageRates } from "./pricing";

interface TopListProps {
  scope: "global" | "project";
  items: TopItem[];
  metricType: MetricType;
  unit: Unit;
  averageRates: AverageRates;
}

export function TopList({
  scope,
  items,
  metricType,
  unit,
  averageRates,
}: TopListProps) {
  const title = scope === "global" ? "Top projects" : "Top tasks";

  // Map items to include their calculated costs and display values
  const enrichedItems = items.map((it) => {
    let cost_in = it.input_tokens * averageRates.input;
    let cost_cached = it.cached_tokens * averageRates.cached;
    let cost_out = it.output_tokens * averageRates.output;
    const cost_total = it.cost > 0 ? it.cost : cost_in + cost_cached + cost_out;

    if (it.cost > 0) {
      const est_total = cost_in + cost_cached + cost_out;
      if (est_total > 0) {
        const ratio = it.cost / est_total;
        cost_in *= ratio;
        cost_cached *= ratio;
        cost_out *= ratio;
      } else {
        cost_in = it.cost;
      }
    }

    const v_total = unit === "cost" ? cost_total : it.tokens;
    const v_in = unit === "cost" ? cost_in : it.input_tokens;
    const v_cached = unit === "cost" ? cost_cached : it.cached_tokens;
    const v_out = unit === "cost" ? cost_out : it.output_tokens;

    let displayValue = v_total;
    if (metricType === "input") displayValue = v_in;
    else if (metricType === "cached") displayValue = v_cached;
    else if (metricType === "output") displayValue = v_out;

    return {
      ...it,
      v_total,
      v_in,
      v_cached,
      v_out,
      displayValue,
    };
  });

  // Sort by display value descending
  const sortedItems = [...enrichedItems].sort((a, b) => b.displayValue - a.displayValue);
  const max = Math.max(...sortedItems.map((i) => i.displayValue), 0.0001);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 h-full flex flex-col min-h-0">
      <div className="flex items-baseline gap-2 mb-3 shrink-0">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          {title}
        </h2>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          by {unit === "cost" ? "cost" : "tokens"}
        </span>
      </div>
      {sortedItems.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
          No data.
        </div>
      ) : (
        <ol className="space-y-2 overflow-y-auto pr-1 min-h-0 list-none">
          {sortedItems.map((it, idx) => (
            <Row
              key={it.id}
              item={it}
              rank={idx + 1}
              max={max}
              metricType={metricType}
              unit={unit}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function Row({
  item,
  rank,
  max,
  metricType,
  unit,
}: {
  item: {
    id: string;
    name: string;
    v_total: number;
    v_in: number;
    v_cached: number;
    v_out: number;
    displayValue: number;
    turns: number;
    agent_split: { agent: string; tokens: number }[];
  };
  rank: number;
  max: number;
  metricType: MetricType;
  unit: Unit;
}) {
  const dominant = item.agent_split.reduce<{
    agent: string;
    tokens: number;
  } | null>(
    (best, a) => (!best || a.tokens > best.tokens ? a : best),
    null,
  );
  
  const shades = dominant
    ? agentShades(dominant.agent)
    : {
        input: "var(--color-text-muted)",
        cached: "color-mix(in srgb, var(--color-text-muted) 30%, transparent)",
        output: "var(--color-highlight)",
      };

  const totalForBar = item.displayValue || 0.0001;
  const ipct = metricType === "total" ? (item.v_in / totalForBar) * 100 : (metricType === "input" ? 100 : 0);
  const cpct = metricType === "total" ? (item.v_cached / totalForBar) * 100 : (metricType === "cached" ? 100 : 0);
  const opct = metricType === "total" ? (item.v_out / totalForBar) * 100 : (metricType === "output" ? 100 : 0);

  const widthPct = (item.displayValue / max) * 100;
  const fmt = unit === "cost" ? formatCost : formatTokens;
  const unitLabel = unit === "cost" ? "" : " tokens";

  return (
    <li className="flex items-start gap-2">
      <span className="w-5 text-[10px] font-mono text-[var(--color-text-muted)] tabular-nums pt-0.5">
        {String(rank).padStart(2, "0")}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-[12px] font-medium text-[var(--color-text)] truncate">
            {item.name}
          </span>
          <span
            className="text-[10px] text-[var(--color-text-muted)] tabular-nums shrink-0"
            title={`${fmt(item.v_in)}${unitLabel} input · ${fmt(
              item.v_cached,
            )}${unitLabel} cached · ${fmt(item.v_out)}${unitLabel} output`}
          >
            {fmt(item.displayValue)} · {formatNumber(item.turns)} turns
          </span>
        </div>
        <div 
          className="flex h-1 rounded-sm overflow-hidden bg-[var(--color-bg-tertiary)]"
          style={{ width: `${widthPct}%` }}
        >
          <div style={{ width: `${ipct}%`, backgroundColor: shades.input }} />
          <div style={{ width: `${cpct}%`, backgroundColor: shades.cached }} />
          <div style={{ width: `${opct}%`, backgroundColor: shades.output }} />
        </div>
      </div>
    </li>
  );
}
