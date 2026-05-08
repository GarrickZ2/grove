/**
 * Top entities — projects in Global scope, tasks in Project scope. Numbered
 * 1..N with a tiny per-agent bar that lets the user spot which agent did
 * the work without scanning a separate breakdown.
 */

import type { TopItem } from "../../../api/statistics";
import { agentColor } from "../agentColors";
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
          by tokens
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
  const totalTurns = item.agent_split.reduce((s, a) => s + a.turns, 0);

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
          <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums shrink-0 tabular-nums">
            {formatTokens(item.tokens)} · {formatNumber(item.turns)}
          </span>
        </div>
        <div className="flex h-1 rounded-sm overflow-hidden bg-[var(--color-bg-tertiary)]">
          {item.agent_split.map((a) => {
            const pct = totalTurns > 0 ? (a.turns / totalTurns) * 100 : 0;
            return (
              <div
                key={a.agent}
                style={{
                  width: `${pct}%`,
                  backgroundColor: agentColor(a.agent),
                }}
                title={`${a.agent}: ${a.turns} turns`}
              />
            );
          })}
        </div>
      </div>
    </li>
  );
}
