/**
 * Models breakdown list — one row per (model, agent) pair, sorted by tokens/cost.
 * Width of the whole bar encodes the row's share of the heaviest model's total.
 */

import type { ModelItem } from "../../../api/statistics";
import { agentShades } from "../agentColors";
import { formatTokens, formatCost } from "../formatters";
import type { MetricType, Unit } from "../ProjectStatsPage";
import { getModelRates } from "./pricing";

interface ModelsListProps {
  items: ModelItem[];
  metricType: MetricType;
  unit: Unit;
}

export function ModelsList({ items, metricType, unit }: ModelsListProps) {
  // Map items to include their exact costs
  const enrichedItems = items.map((it) => {
    const rates = getModelRates(it.model || it.agent);
    let cost_in = it.input_tokens * rates.input;
    let cost_cached = it.cached_tokens * rates.cached;
    let cost_out = it.output_tokens * rates.output;
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
          Models
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
        <div className="space-y-2.5 overflow-y-auto pr-1 min-h-0">
          {sortedItems.map((it, i) => (
            <Row
              key={`${it.model}-${it.agent}-${i}`}
              item={it}
              max={max}
              metricType={metricType}
              unit={unit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  item,
  max,
  metricType,
  unit,
}: {
  item: {
    model: string;
    agent: string;
    v_total: number;
    v_in: number;
    v_cached: number;
    v_out: number;
    displayValue: number;
    turns: number;
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
    tokens: number;
  };
  max: number;
  metricType: MetricType;
  unit: Unit;
}) {
  const widthPct = (item.displayValue / max) * 100;
  
  const totalForBar = item.displayValue || 0.0001;
  const ipct = metricType === "total" ? (item.v_in / totalForBar) * 100 : (metricType === "input" ? 100 : 0);
  const cpct = metricType === "total" ? (item.v_cached / totalForBar) * 100 : (metricType === "cached" ? 100 : 0);
  const opct = metricType === "total" ? (item.v_out / totalForBar) * 100 : (metricType === "output" ? 100 : 0);
  
  const shades = agentShades(item.agent);
  const modelLabel = item.model || "(unknown)";
  const fmt = unit === "cost" ? formatCost : formatTokens;
  const unitLabel = unit === "cost" ? "" : " tokens";

  return (
    <div className="text-[11px]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="truncate flex items-center gap-1.5">
          <span className="text-[var(--color-text)] font-medium truncate">
            {modelLabel}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)] truncate">
            · {item.agent}
          </span>
        </span>
        <span
          className="text-[var(--color-text-muted)] tabular-nums shrink-0"
          title={`${fmt(item.v_in)}${unitLabel} input · ${fmt(
            item.v_cached,
          )}${unitName(unit)} cached · ${fmt(item.v_out)}${unitName(unit)} output`}
        >
          {fmt(item.displayValue)} · {item.turns} turns
        </span>
      </div>
      <div
        className="relative h-1.5 rounded-sm bg-[var(--color-bg-tertiary)] overflow-hidden"
        role="progressbar"
        aria-valuenow={widthPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="absolute left-0 top-0 h-full flex"
          style={{ width: `${widthPct}%` }}
        >
          <div style={{ width: `${ipct}%`, backgroundColor: shades.input }} />
          <div style={{ width: `${cpct}%`, backgroundColor: shades.cached }} />
          <div style={{ width: `${opct}%`, backgroundColor: shades.output }} />
        </div>
      </div>
    </div>
  );
}

function unitName(unit: Unit): string {
  return unit === "cost" ? "" : " tokens";
}
