/**
 * Stacked area / bar chart — single metric over time, stacked by agent
 * when the data permits.
 *
 * Metric selector:
 *   turns  – per-agent turns (stacked)
 *   total  – per-agent tokens summed (stacked)
 *   input  – bucket-level input tokens (single area; backend does not split
 *            input/cached/output per agent today)
 *   cached – bucket-level cached_read tokens
 *   output – bucket-level output tokens
 *
 * Hand-rolled SVG (no chart library) keeps the dependency surface small;
 * stat panels render a few hundred buckets max, well under what plain SVG
 * handles. Hover tooltip surfaces the bucket's segment breakdown.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Bucket, TimeseriesBucket } from "../../../api/statistics";
import { agentColor } from "../agentColors";
import { formatTokens, formatNumber } from "../formatters";
import { TOKEN_TYPE_COLORS } from "./KpiRow";

type Metric = "turns" | "total" | "input" | "cached" | "output";

const METRICS: { id: Metric; label: string }[] = [
  { id: "turns", label: "Turns" },
  { id: "total", label: "Total" },
  { id: "input", label: "Input" },
  { id: "cached", label: "Cached" },
  { id: "output", label: "Output" },
];

interface Segment {
  /** Display label for legend / tooltip. */
  label: string;
  /** Numeric value (token count or turn count). */
  value: number;
  /** SVG fill color. */
  color: string;
}

interface Stack {
  ts: number;
  segs: Segment[];
}

/** Whether a metric stacks per agent (true) or renders as a single layer. */
function isAgentStacked(m: Metric): boolean {
  return m === "turns" || m === "total";
}

/** Color used when a metric is rendered as a single layer (input/cached/output). */
function singleColor(m: Metric): string {
  if (m === "input") return TOKEN_TYPE_COLORS.input;
  if (m === "cached") return TOKEN_TYPE_COLORS.cached;
  if (m === "output") return TOKEN_TYPE_COLORS.output;
  return "var(--color-highlight)";
}

function bucketTotal(b: TimeseriesBucket, m: Metric): number {
  switch (m) {
    case "turns":
      return b.turns;
    case "total":
      return b.tokens_in + b.tokens_cached + b.tokens_out;
    case "input":
      return b.tokens_in;
    case "cached":
      return b.tokens_cached;
    case "output":
      return b.tokens_out;
  }
}

interface ActivityOverTimeProps {
  buckets: TimeseriesBucket[];
  bucket?: Bucket;
}

export function ActivityOverTime({ buckets, bucket }: ActivityOverTimeProps) {
  const [metric, setMetric] = useState<Metric>("total");

  // Stable agent ordering used both for stacking order and the legend in
  // agent-stacked modes. Sort by total contribution descending so the
  // heaviest agent sits at the bottom of the stack.
  const agentOrder = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of buckets) {
      for (const a of b.per_agent) {
        const v = metric === "turns" ? a.turns : a.tokens;
        totals.set(a.agent, (totals.get(a.agent) ?? 0) + v);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }, [buckets, metric]);

  const stacks: Stack[] = useMemo(() => {
    if (isAgentStacked(metric)) {
      return buckets.map((b) => {
        const map = new Map(b.per_agent.map((a) => [a.agent, a]));
        return {
          ts: b.bucket_start,
          segs: agentOrder.map((agent) => ({
            label: agent,
            value:
              metric === "turns"
                ? (map.get(agent)?.turns ?? 0)
                : (map.get(agent)?.tokens ?? 0),
            color: agentColor(agent),
          })),
        };
      });
    }
    // Single-layer mode: input / cached / output don't have per-agent
    // detail in the timeseries today, so we render the bucket total in
    // the metric's brand color.
    const color = singleColor(metric);
    return buckets.map((b) => ({
      ts: b.bucket_start,
      segs: [{ label: metric, value: bucketTotal(b, metric), color }],
    }));
  }, [buckets, metric, agentOrder]);

  const legend: { label: string; color: string }[] = isAgentStacked(metric)
    ? agentOrder.map((a) => ({ label: a, color: agentColor(a) }))
    : [{ label: metric, color: singleColor(metric) }];

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 shrink-0 gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-text)] shrink-0">
            Activity over time
          </h2>
          <Legend items={legend} />
        </div>
        <MetricSelector value={metric} onChange={setMetric} />
      </div>
      {buckets.length === 0 ? (
        <Empty />
      ) : (
        <Chart stacks={stacks} metric={metric} bucket={bucket} />
      )}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-3 text-[10px] text-[var(--color-text-muted)] truncate">
      {items.slice(0, 6).map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1">
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ backgroundColor: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function MetricSelector({
  value,
  onChange,
}: {
  value: Metric;
  onChange: (m: Metric) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-0.5 shrink-0">
      {METRICS.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          className={`px-2 py-0.5 rounded text-[10px] font-medium ${
            value === m.id
              ? "bg-[var(--color-bg)] text-[var(--color-text)]"
              : "text-[var(--color-text-muted)]"
          }`}
        >
          {m.label}
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
  stacks,
  metric,
  bucket,
}: {
  stacks: Stack[];
  metric: Metric;
  bucket?: Bucket;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const computed = useMemo(() => {
    return stacks.map((s) => {
      let cum = 0;
      const layers = s.segs.map((seg) => {
        const layer = { ...seg, base: cum };
        cum += seg.value;
        return layer;
      });
      return { ts: s.ts, total: cum, layers };
    });
  }, [stacks]);

  const yMax = Math.max(...computed.map((s) => s.total), 1);

  const W = 1000;
  const H = 280;
  const innerW = W - PADDING.left - PADDING.right;
  const innerH = H - PADDING.top - PADDING.bottom;

  const xAt = (i: number) =>
    PADDING.left +
    (computed.length === 1
      ? innerW / 2
      : (i / (computed.length - 1)) * innerW);
  const yAt = (v: number) => PADDING.top + innerH - (v / yMax) * innerH;

  const isSingle = computed.length === 1;
  const barWidth = innerW / 8;
  const layerCount = computed[0]?.layers.length ?? 0;

  const shapes = Array.from({ length: layerCount }, (_, layerIdx) => {
    const layerLabel = computed[0].layers[layerIdx].label;
    const layerColor = computed[0].layers[layerIdx].color;
    if (isSingle) {
      const seg = computed[0].layers[layerIdx];
      const cx = xAt(0);
      const x = cx - barWidth / 2;
      const y1 = yAt(seg.base + seg.value);
      const y0 = yAt(seg.base);
      return {
        label: layerLabel,
        color: layerColor,
        kind: "rect" as const,
        x,
        y: y1,
        w: barWidth,
        h: Math.max(0, y0 - y1),
      };
    }
    const top: string[] = [];
    const bot: string[] = [];
    computed.forEach((s, i) => {
      const seg = s.layers[layerIdx];
      const x = xAt(i);
      top.push(`${x},${yAt(seg.base + seg.value)}`);
      bot.push(`${x},${yAt(seg.base)}`);
    });
    bot.reverse();
    return {
      label: layerLabel,
      color: layerColor,
      kind: "path" as const,
      d: `M ${top.join(" L ")} L ${bot.join(" L ")} Z`,
    };
  });

  const yTicks = makeTicks(yMax, 4);
  const valueFmt = metric === "turns" ? formatNumber : formatTokens;

  return (
    <div className="flex-1 min-h-0 relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-full"
        onMouseLeave={() => setHoverIdx(null)}
      >
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
              {valueFmt(t)}
            </text>
          </g>
        ))}

        {[0, Math.floor(computed.length / 2), computed.length - 1]
          .filter((i, idx, arr) => computed[i] && arr.indexOf(i) === idx)
          .map((i) => (
            <text
              key={i}
              x={xAt(i)}
              y={H - 6}
              fontSize="10"
              textAnchor="middle"
              fill="var(--color-text-muted)"
            >
              {formatBucketLabel(computed[i].ts, false, bucket)}
            </text>
          ))}

        {shapes.map((sh) =>
          sh.kind === "rect" ? (
            <rect
              key={sh.label}
              x={sh.x}
              y={sh.y}
              width={sh.w}
              height={sh.h}
              fill={sh.color}
            />
          ) : (
            <path key={sh.label} d={sh.d} fill={sh.color} />
          ),
        )}

        {computed.map((_, i) => {
          const bandW = innerW / Math.max(computed.length, 1);
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

        {hoverIdx != null && computed[hoverIdx] && (
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

      {hoverIdx != null && computed[hoverIdx] && (
        <Tooltip
          stack={computed[hoverIdx]}
          metric={metric}
          xPct={(hoverIdx / Math.max(computed.length - 1, 1)) * 100}
          bucket={bucket}
        />
      )}
    </div>
  );
}

function Tooltip({
  stack,
  metric,
  xPct,
  bucket,
}: {
  stack: { ts: number; total: number; layers: Segment[] };
  metric: Metric;
  xPct: number;
  bucket?: Bucket;
}) {
  const fmt = metric === "turns" ? formatNumber : formatTokens;
  // Measure the rendered tooltip width on first paint so the right-edge
  // clamp uses the actual size instead of a hardcoded 180px guess (which
  // broke whenever locale formatting or bucket label pushed it wider).
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(180);
  useLayoutEffect(() => {
    if (ref.current) setWidth(ref.current.offsetWidth);
  }, [stack, metric]);
  const left = `clamp(8px, calc(${xPct}% + 4px), calc(100% - ${width + 8}px))`;
  const unit = metric === "turns" ? "turns" : "tokens";
  return (
    <div
      ref={ref}
      className="absolute top-2 pointer-events-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[10px] shadow-lg"
      style={{ left, minWidth: 160 }}
    >
      <div className="text-[var(--color-text-muted)] mb-1">
        {formatBucketLabel(stack.ts, true, bucket)}
      </div>
      <div className="text-[var(--color-text)] font-semibold mb-1 tabular-nums">
        {fmt(stack.total)} {unit}
      </div>
      {stack.layers
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.label}
            className="flex items-center justify-between gap-3 tabular-nums"
          >
            <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
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

function formatBucketLabel(ts: number, full = false, bucket?: Bucket): string {
  const d = new Date(ts * 1000);
  // Match label granularity to bucket size — showing "Mar 5, 14:30" for a
  // monthly bucket implies precision the data doesn't have.
  if (bucket === "monthly") {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  }
  if (bucket === "weekly") {
    return full
      ? `Week of ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  if (full) {
    const opts: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
    };
    if (bucket === "hourly" || bucket == null) {
      opts.hour = "numeric";
      opts.minute = "2-digit";
    }
    return d.toLocaleString(undefined, opts);
  }
  if (bucket === "hourly") {
    return d.toLocaleTimeString(undefined, { hour: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}
