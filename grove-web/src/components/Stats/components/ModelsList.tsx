/**
 * Models breakdown list — one row per (model, agent) pair, sorted by tokens.
 * Each row has a horizontal bar where total tokens fills the bar in the
 * agent's color, with the cached-read portion overlaid in a muted shade so
 * users can eyeball cache efficiency at a glance.
 */

import type { ModelItem } from "../../../api/statistics";
import { agentColor } from "../agentColors";
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
          tokens · cached overlay
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
  const cachedPct =
    item.tokens > 0 ? (item.cached_tokens / item.tokens) * widthPct : 0;
  const color = agentColor(item.agent);
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
        <span className="text-[var(--color-text-muted)] tabular-nums shrink-0">
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
        <div
          className="absolute left-0 top-0 h-full rounded-sm"
          style={{ width: `${widthPct}%`, backgroundColor: color }}
        />
        {cachedPct > 0 && (
          <div
            className="absolute left-0 top-0 h-full rounded-sm"
            style={{
              width: `${cachedPct}%`,
              backgroundColor: `color-mix(in srgb, ${color} 55%, white 0%)`,
              mixBlendMode: "multiply",
              opacity: 0.55,
            }}
            title={`${formatTokens(item.cached_tokens)} cached`}
          />
        )}
      </div>
    </div>
  );
}
