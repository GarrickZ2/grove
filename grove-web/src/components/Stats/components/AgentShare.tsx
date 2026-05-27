/**
 * Donut chart of "agent share by tokens" + a bar list on the right.
 *
 * Weight-adjusted dynamically by unit (Tokens vs Cost).
 */

import type { AgentShareItem } from "../../../api/statistics";
import { agentColor } from "../agentColors";
import { formatTokens, formatCost } from "../formatters";
import type { Unit } from "../ProjectStatsPage";
import type { AverageRates } from "./pricing";

interface AgentShareProps {
  items: AgentShareItem[];
  unit: Unit;
  averageRates: AverageRates;
}

export function AgentShare({ items, unit, averageRates }: AgentShareProps) {
  const valueFor = (item: AgentShareItem) => {
    if (unit === "cost") {
      return item.cost > 0 ? item.cost : item.tokens * averageRates.total;
    }
    return item.tokens;
  };
  const total = items.reduce((sum, i) => sum + valueFor(i), 0);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 h-full flex flex-col min-h-0">
      <div className="flex items-baseline gap-2 mb-3 shrink-0">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          Agent share
        </h2>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          by {unit === "cost" ? "cost" : "tokens"}
        </span>
      </div>
      {total === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
          No data.
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-2 gap-4 items-center min-h-0">
          <Donut items={items} total={total} unit={unit} valueFor={valueFor} />
          <BarList items={items} total={total} unit={unit} valueFor={valueFor} />
        </div>
      )}
    </div>
  );
}

function Donut({
  items,
  total,
  unit,
  valueFor,
}: {
  items: AgentShareItem[];
  total: number;
  unit: Unit;
  valueFor: (item: AgentShareItem) => number;
}) {
  const r = 42;
  const cx = 60;
  const cy = 60;
  const c = 2 * Math.PI * r;
  const slices = items.map((item) => ({
    ...item,
    slice: (valueFor(item) / total) * c,
  }));
  const offsets: number[] = [];
  slices.reduce((acc, s, i) => {
    offsets[i] = acc;
    return acc + s.slice;
  }, 0);

  const fmt = unit === "cost" ? formatCost : formatTokens;

  return (
    <div className="relative w-full max-w-[180px] aspect-square mx-auto">
      <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--color-bg-tertiary)"
          strokeWidth="14"
        />
        {slices.map((item, i) => (
          <circle
            key={item.agent}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={agentColor(item.agent)}
            strokeWidth="14"
            strokeDasharray={`${item.slice} ${c - item.slice}`}
            strokeDashoffset={-offsets[i]}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center select-none">
        <div className="text-2xl font-bold text-[var(--color-text)] tabular-nums leading-none">
          {fmt(total)}
        </div>
        <div className="text-[9px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] mt-1">
          {unit === "cost" ? "USD" : "tokens"}
        </div>
      </div>
    </div>
  );
}

function BarList({
  items,
  total,
  unit,
  valueFor,
}: {
  items: AgentShareItem[];
  total: number;
  unit: Unit;
  valueFor: (item: AgentShareItem) => number;
}) {
  const fmt = unit === "cost" ? formatCost : formatTokens;

  return (
    <div className="space-y-2 overflow-y-auto pr-1 min-h-0">
      {items.slice(0, 8).map((it) => {
        const val = valueFor(it);
        const pct = total > 0 ? (val / total) * 100 : 0;
        return (
          <div key={it.agent} className="text-[11px]">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span
                className="inline-flex items-center gap-1.5 truncate"
                style={{ color: agentColor(it.agent) }}
              >
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ backgroundColor: agentColor(it.agent) }}
                />
                <span className="text-[var(--color-text)] truncate">
                  {it.agent}
                </span>
              </span>
              <span className="text-[var(--color-text-muted)] tabular-nums shrink-0">
                {fmt(val)} · {pct.toFixed(0)}%
              </span>
            </div>
            <div
              className="h-1 rounded-sm bg-[var(--color-bg-tertiary)] overflow-hidden"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-sm transition-[width] duration-300"
                style={{
                  width: `${pct}%`,
                  backgroundColor: agentColor(it.agent),
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
