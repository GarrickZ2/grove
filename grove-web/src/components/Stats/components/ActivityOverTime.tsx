/**
 * Stacked area chart — tokens or turns over time, split per agent.
 *
 * Hand-rolled SVG (no chart library) keeps the dependency surface small;
 * stat panels render a few hundred buckets max, well under what plain SVG
 * handles. Hover tooltip surfaces the bucket's per-agent breakdown.
 */

import { useMemo, useState } from "react";

import type { TimeseriesBucket } from "../../../api/statistics";
import { agentColor } from "../agentColors";
import { formatTokens, formatNumber } from "../formatters";

type Metric = "tokens" | "turns";

export function ActivityOverTime({ buckets }: { buckets: TimeseriesBucket[] }) {
  const [metric, setMetric] = useState<Metric>("tokens");

  // Build a stable agent ordering by total contribution (largest first) so
  // colors and stacking order don't flicker between renders.
  const agentOrder = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of buckets) {
      for (const a of b.per_agent) {
        const v = metric === "tokens" ? a.tokens : a.turns;
        totals.set(a.agent, (totals.get(a.agent) ?? 0) + v);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }, [buckets, metric]);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">
            Activity over time
          </h2>
          <Legend agents={agentOrder} />
        </div>
        <MetricToggle value={metric} onChange={setMetric} />
      </div>
      {buckets.length === 0 ? (
        <Empty />
      ) : (
        <Chart buckets={buckets} agentOrder={agentOrder} metric={metric} />
      )}
    </div>
  );
}

function Legend({ agents }: { agents: string[] }) {
  if (agents.length === 0) return null;
  return (
    <div className="flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
      {agents.slice(0, 6).map((a) => (
        <span key={a} className="inline-flex items-center gap-1">
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ backgroundColor: agentColor(a) }}
          />
          {a}
        </span>
      ))}
    </div>
  );
}

function MetricToggle({
  value,
  onChange,
}: {
  value: Metric;
  onChange: (m: Metric) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-0.5">
      {(["tokens", "turns"] as Metric[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`px-2 py-0.5 rounded text-[10px] font-medium ${
            value === m
              ? "bg-[var(--color-bg)] text-[var(--color-text)]"
              : "text-[var(--color-text-muted)]"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
      No activity in this range.
    </div>
  );
}

// ── Chart ───────────────────────────────────────────────────────────────

const PADDING = { top: 8, right: 12, bottom: 22, left: 40 };

function Chart({
  buckets,
  agentOrder,
  metric,
}: {
  buckets: TimeseriesBucket[];
  agentOrder: string[];
  metric: Metric;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Compute per-bucket stacked values per agent (in agentOrder).
  const stacks = useMemo(() => {
    return buckets.map((b) => {
      const map = new Map(b.per_agent.map((a) => [a.agent, a]));
      let cum = 0;
      const segs = agentOrder.map((agent) => {
        const item = map.get(agent);
        const v = item ? (metric === "tokens" ? item.tokens : item.turns) : 0;
        const seg = { agent, base: cum, value: v };
        cum += v;
        return seg;
      });
      return { ts: b.bucket_start, total: cum, segs };
    });
  }, [buckets, agentOrder, metric]);

  const yMax = Math.max(...stacks.map((s) => s.total), 1);

  // Render-time dimensions are CSS-driven; SVG uses 0..1 viewBox normalized
  // by hard pixel constants. We use a viewBox of 1000x300 and let CSS scale
  // it to the parent. y axis uses 4 ticks.
  const W = 1000;
  const H = 280;
  const innerW = W - PADDING.left - PADDING.right;
  const innerH = H - PADDING.top - PADDING.bottom;

  // x positions: distribute buckets across innerW; if only 1 bucket, center it.
  const xAt = (i: number) =>
    PADDING.left +
    (stacks.length === 1
      ? innerW / 2
      : (i / (stacks.length - 1)) * innerW);
  const yAt = (v: number) => PADDING.top + innerH - (v / yMax) * innerH;

  // Build polygons per agent layer (top edge + bottom edge reversed).
  const layers = agentOrder.map((agent, layerIdx) => {
    const top: string[] = [];
    const bot: string[] = [];
    stacks.forEach((s, i) => {
      const seg = s.segs[layerIdx];
      const x = xAt(i);
      const y0 = yAt(seg.base);
      const y1 = yAt(seg.base + seg.value);
      top.push(`${x},${y1}`);
      bot.push(`${x},${y0}`);
    });
    bot.reverse();
    return {
      agent,
      d: `M ${top.join(" L ")} L ${bot.join(" L ")} Z`,
    };
  });

  const yTicks = makeTicks(yMax, 4);

  return (
    <div className="flex-1 min-h-0 relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-full"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Y grid + labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={PADDING.left}
              x2={W - PADDING.right}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke="var(--color-border)"
              strokeOpacity="0.5"
              strokeDasharray="2 4"
            />
            <text
              x={PADDING.left - 6}
              y={yAt(t) + 3}
              fontSize="10"
              textAnchor="end"
              fill="var(--color-text-muted)"
              className="tabular-nums"
            >
              {metric === "tokens" ? formatTokens(t) : formatNumber(t)}
            </text>
          </g>
        ))}

        {/* X labels: first, middle, last */}
        {[0, Math.floor(stacks.length / 2), stacks.length - 1]
          .filter((i, idx, arr) => stacks[i] && arr.indexOf(i) === idx)
          .map((i) => (
            <text
              key={i}
              x={xAt(i)}
              y={H - 6}
              fontSize="10"
              textAnchor="middle"
              fill="var(--color-text-muted)"
            >
              {formatBucketLabel(stacks[i].ts)}
            </text>
          ))}

        {/* Stacked layers */}
        {layers.map((l) => (
          <path key={l.agent} d={l.d} fill={agentColor(l.agent)} />
        ))}

        {/* Hover hit-targets — invisible vertical bands over each bucket */}
        {stacks.map((_s, i) => {
          const bandW = innerW / Math.max(stacks.length, 1);
          return (
            <rect
              key={i}
              x={xAt(i) - bandW / 2}
              y={PADDING.top}
              width={bandW}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
            />
          );
        })}

        {/* Hover line */}
        {hoverIdx != null && stacks[hoverIdx] && (
          <line
            x1={xAt(hoverIdx)}
            x2={xAt(hoverIdx)}
            y1={PADDING.top}
            y2={H - PADDING.bottom}
            stroke="var(--color-text-muted)"
            strokeOpacity="0.5"
          />
        )}
      </svg>

      {hoverIdx != null && stacks[hoverIdx] && (
        <Tooltip
          stack={stacks[hoverIdx]}
          metric={metric}
          xPct={(hoverIdx / Math.max(stacks.length - 1, 1)) * 100}
        />
      )}
    </div>
  );
}

function Tooltip({
  stack,
  metric,
  xPct,
}: {
  stack: { ts: number; total: number; segs: { agent: string; value: number }[] };
  metric: Metric;
  xPct: number;
}) {
  const fmt = metric === "tokens" ? formatTokens : formatNumber;
  // Anchor tooltip near hovered bar; clamp into the panel.
  const left = `clamp(8px, calc(${xPct}% + 4px), calc(100% - 180px))`;
  return (
    <div
      className="absolute top-2 pointer-events-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[10px] shadow-lg"
      style={{ left, minWidth: 160 }}
    >
      <div className="text-[var(--color-text-muted)] mb-1">
        {formatBucketLabel(stack.ts, true)}
      </div>
      <div className="text-[var(--color-text)] font-semibold mb-1 tabular-nums">
        {fmt(stack.total)} {metric}
      </div>
      {stack.segs
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.agent}
            className="flex items-center justify-between gap-3 tabular-nums"
          >
            <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ backgroundColor: agentColor(s.agent) }}
              />
              {s.agent}
            </span>
            <span className="text-[var(--color-text)]">{fmt(s.value)}</span>
          </div>
        ))}
    </div>
  );
}

function makeTicks(max: number, count: number): number[] {
  if (max <= 0) return [0];
  const step = max / count;
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(Math.round(step * i));
  return ticks;
}

function formatBucketLabel(ts: number, full = false): string {
  const d = new Date(ts * 1000);
  if (full) {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}
