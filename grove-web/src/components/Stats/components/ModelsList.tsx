/**
 * Models breakdown list — one row per (model, agent) pair, sorted by tokens.
 * Each row's bar is a 3-segment stack (input / cached / output) using three
 * shades of the agent's brand color. Width of the whole bar encodes the
 * row's share of the heaviest model's total.
 */

import type { ModelItem } from "../../../api/statistics";
import { agentShades } from "../agentColors";
import { formatTokens } from "../formatters";

export function ModelsList({ items }: { items: ModelItem[] }) {
  const max = Math.max(...items.map((i) => i.tokens), 1);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 h-full flex flex-col min-h-0">
      <div className="flex items-baseline gap-2 mb-3 shrink-0">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          Models
        </h2>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          input · cached · output
        </span>
      </div>
      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
          No data.
        </div>
      ) : (
        <div className="space-y-2.5 overflow-y-auto pr-1 min-h-0">
          {items.map((it, i) => (
            <Row key={`${it.model}-${it.agent}-${i}`} item={it} max={max} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ item, max }: { item: ModelItem; max: number }) {
  const widthPct = (item.tokens / max) * 100;
  const total = item.tokens || 1;
  const ipct = (item.input_tokens / total) * 100;
  const cpct = (item.cached_tokens / total) * 100;
  const opct = (item.output_tokens / total) * 100;
  const shades = agentShades(item.agent);
  const modelLabel = item.model || "(unknown)";

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
          title={`${formatTokens(item.input_tokens)} input · ${formatTokens(
            item.cached_tokens,
          )} cached · ${formatTokens(item.output_tokens)} output`}
        >
          {formatTokens(item.tokens)} · {item.turns} turns
        </span>
      </div>
      <div
        className="relative h-1.5 rounded-sm bg-[var(--color-bg-tertiary)] overflow-hidden"
        role="progressbar"
        aria-valuenow={widthPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {/* Outer width = row's share of max; the three inner segments split
            that width by input / cached / output proportions of this row. */}
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
