/**
 * Top entities — projects in Global scope, tasks in Project scope.
 * Each row shows a 3-segment input / cached / output bar in three shades
 * of the row's *dominant agent* color (whichever agent contributed the
 * most tokens in this entity). Falls back to a neutral palette when no
 * agent_split is available.
 */

import type { TopItem } from "../../../api/statistics";
import { agentShades } from "../agentColors";
import { formatTokens, formatNumber } from "../formatters";

export function TopList({
  scope,
  items,
}: {
  scope: "global" | "project";
  items: TopItem[];
}) {
  const title = scope === "global" ? "Top projects" : "Top tasks";

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 h-full flex flex-col min-h-0">
      <div className="flex items-baseline gap-2 mb-3 shrink-0">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          {title}
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
        <ol className="space-y-2 overflow-y-auto pr-1 min-h-0 list-none">
          {items.map((it, idx) => (
            <Row key={it.id} item={it} rank={idx + 1} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Row({ item, rank }: { item: TopItem; rank: number }) {
  // Use the dominant agent (highest tokens in agent_split) to color the
  // 3-shade bar. Each task usually has a primary driving agent; mixing
  // multiple agents' palettes inside one bar would be illegible.
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

  const total = item.tokens || 1;
  const ipct = (item.input_tokens / total) * 100;
  const cpct = (item.cached_tokens / total) * 100;
  const opct = (item.output_tokens / total) * 100;

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
            title={`${formatTokens(item.input_tokens)} input · ${formatTokens(
              item.cached_tokens,
            )} cached · ${formatTokens(item.output_tokens)} output`}
          >
            {formatTokens(item.tokens)} · {formatNumber(item.turns)}
          </span>
        </div>
        <div className="flex h-1 rounded-sm overflow-hidden bg-[var(--color-bg-tertiary)]">
          <div style={{ width: `${ipct}%`, backgroundColor: shades.input }} />
          <div style={{ width: `${cpct}%`, backgroundColor: shades.cached }} />
          <div style={{ width: `${opct}%`, backgroundColor: shades.output }} />
        </div>
      </div>
    </li>
  );
}
