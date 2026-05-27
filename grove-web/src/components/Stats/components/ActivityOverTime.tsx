/**
 * Stacked area / bar chart — single metric over time, stacked by agent
 * when the data permits.
 *
 * Receives MetricType and Unit from the board-level state.
 * Smooth SVG curves via cubic Bezier smoothing.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Bucket, TimeseriesBucket } from "../../../api/statistics";
import { agentColor } from "../agentColors";
import { formatTokens, formatCost } from "../formatters";
import { TOKEN_TYPE_COLORS } from "./KpiRow";
import type { MetricType, Unit } from "../ProjectStatsPage";
import type { AverageRates } from "./pricing";

interface Segment {
  /** Display label for legend / tooltip. */
  label: string;
  /** Numeric value (token count or cost amount). */
  value: number;
  /** SVG fill color. */
  color: string;
}

interface Stack {
  ts: number;
  segs: Segment[];
}

/** Whether a metric stacks per agent (true) or renders as a single layer. */
function isAgentStacked(m: MetricType): boolean {
  return m === "total";
}

/** Color used when a metric is rendered as a single layer (input/cached/output). */
function singleColor(m: MetricType): string {
  if (m === "input") return TOKEN_TYPE_COLORS.input;
  if (m === "cached") return TOKEN_TYPE_COLORS.cached;
  if (m === "output") return TOKEN_TYPE_COLORS.output;
  return "var(--color-highlight)";
}

function bucketValue(b: TimeseriesBucket, m: MetricType, u: Unit, r: AverageRates): number {
  let cost_in = b.tokens_in * r.input;
  let cost_cached = b.tokens_cached * r.cached;
  let cost_out = b.tokens_out * r.output;

  if (u === "cost" && b.cost_total > 0) {
    const est_total = cost_in + cost_cached + cost_out;
    if (est_total > 0) {
      const ratio = b.cost_total / est_total;
      cost_in *= ratio;
      cost_cached *= ratio;
      cost_out *= ratio;
    } else {
      cost_in = b.cost_total;
    }
  }

  if (u === "cost") {
    switch (m) {
      case "total":
        return b.cost_total > 0 ? b.cost_total : cost_in + cost_cached + cost_out;
      case "input":
        return cost_in;
      case "cached":
        return cost_cached;
      case "output":
        return cost_out;
    }
  } else {
    switch (m) {
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
}

interface ActivityOverTimeProps {
  buckets: TimeseriesBucket[];
  bucket?: Bucket;
  metricType: MetricType;
  unit: Unit;
  averageRates: AverageRates;
}

export function ActivityOverTime({
  buckets,
  bucket,
  metricType,
  unit,
  averageRates,
}: ActivityOverTimeProps) {

  // Stable agent ordering used both for stacking order and the legend in
  // agent-stacked modes. Sort by total contribution descending so the
  // heaviest agent sits at the bottom of the stack.
  const agentOrder = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of buckets) {
      for (const a of b.per_agent) {
        totals.set(a.agent, (totals.get(a.agent) ?? 0) + a.tokens);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }, [buckets]);

  const stacks: Stack[] = useMemo(() => {
    if (isAgentStacked(metricType)) {
      return buckets.map((b) => {
        const map = new Map(b.per_agent.map((a) => [a.agent, a]));
        
        const total_tokens = b.tokens_in + b.tokens_cached + b.tokens_out;
        const cost_in = b.tokens_in * averageRates.input;
        const cost_cached = b.tokens_cached * averageRates.cached;
        const cost_out = b.tokens_out * averageRates.output;
        const total_cost = b.cost_total > 0 ? b.cost_total : cost_in + cost_cached + cost_out;
        const avg_cost_per_token = total_tokens > 0 ? total_cost / total_tokens : 0;

        return {
          ts: b.bucket_start,
          segs: agentOrder.map((agent) => {
            const agentBucket = map.get(agent);
            const agentTokens = agentBucket?.tokens ?? 0;
            const agentCost = agentBucket?.cost ?? 0;

            const value = unit === "cost"
              ? (agentCost > 0 ? agentCost : agentTokens * avg_cost_per_token)
              : agentTokens;

            return {
              label: agent,
              value,
              color: agentColor(agent),
            };
          }),
        };
      });
    }

    // Single-layer mode: input / cached / output don't have per-agent
    // detail in the timeseries today, so we render the bucket total in
    // the metric's brand color.
    const color = singleColor(metricType);
    const label = metricType === "cached" ? "cache" : metricType;
    return buckets.map((b) => ({
      ts: b.bucket_start,
      segs: [{ label, value: bucketValue(b, metricType, unit, averageRates), color }],
    }));
  }, [buckets, metricType, unit, agentOrder, averageRates]);

  const legend: { label: string; color: string }[] = isAgentStacked(metricType)
    ? agentOrder.map((a) => ({ label: a, color: agentColor(a) }))
    : [{ label: metricType === "cached" ? "cache" : metricType, color: singleColor(metricType) }];

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 shrink-0 gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-text)] shrink-0">
            Activity over time
          </h2>
          <Legend items={legend} />
        </div>
      </div>
      {buckets.length === 0 ? (
        <Empty />
      ) : (
        <Chart stacks={stacks} metricType={metricType} unit={unit} bucket={bucket} />
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

function Empty() {
  return (
    <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
      No activity in this range.
    </div>
  );
}

// ── Chart ───────────────────────────────────────────────────────────────

const PADDING = { top: 8, right: 12, bottom: 22, left: 45 };

/**
 * Custom cubic Bezier curve path generator.
 * Takes control points based on neighboring coordinates to ensure smooth, natural lines
 * that avoid rigid sharp corners while perfectly maintaining stack boundaries.
 */
function getBezierPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
  }

  let d = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  const t = 0.15; // tension factor for smoothing

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;

    const cp1x = p1.x + (p2.x - p0.x) * t;
    const cp1y = p1.y + (p2.y - p0.y) * t;

    const cp2x = p2.x - (p3.x - p1.x) * t;
    const cp2y = p2.y - (p3.y - p1.y) * t;

    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function Chart({
  stacks,
  metricType,
  unit,
  bucket,
}: {
  stacks: Stack[];
  metricType: MetricType;
  unit: Unit;
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

  const yMax = Math.max(...computed.map((s) => s.total), 0.0001);

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
    
    const topPoints: { x: number; y: number }[] = [];
    const botPoints: { x: number; y: number }[] = [];
    computed.forEach((s, i) => {
      const seg = s.layers[layerIdx];
      const x = xAt(i);
      topPoints.push({ x, y: yAt(seg.base + seg.value) });
      botPoints.push({ x, y: yAt(seg.base) });
    });

    const topPath = getBezierPath(topPoints);
    const botPointsReversed = [...botPoints].reverse();
    const botPathRaw = getBezierPath(botPointsReversed);
    // Connect top path to bot path, then close with Z
    const botPath = botPathRaw.replace(/^M/, "L");
    const d = `${topPath} ${botPath} Z`;

    return {
      label: layerLabel,
      color: layerColor,
      kind: "path" as const,
      d,
      topPath,
    };
  });

  const yTicks = makeTicks(yMax, 4);
  const valueFmt = unit === "cost" ? formatCost : formatTokens;

  return (
    <div className="flex-1 min-h-0 relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-full animate-fade-in"
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
            <g key={sh.label}>
              {/* Stack filled area */}
              <path 
                d={sh.d} 
                fill={sh.color} 
                fillOpacity="0.85"
                className="transition-all duration-300"
              />
              {/* Crisp top highlight border line */}
              <path
                d={sh.topPath}
                fill="none"
                stroke={sh.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-all duration-300"
              />
            </g>
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
          metricType={metricType}
          unit={unit}
          xPct={(hoverIdx / Math.max(computed.length - 1, 1)) * 100}
          bucket={bucket}
        />
      )}
    </div>
  );
}

function Tooltip({
  stack,
  metricType,
  unit,
  xPct,
  bucket,
}: {
  stack: { ts: number; total: number; layers: Segment[] };
  metricType: MetricType;
  unit: Unit;
  xPct: number;
  bucket?: Bucket;
}) {
  const fmt = unit === "cost" ? formatCost : formatTokens;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(180);
  useLayoutEffect(() => {
    if (ref.current) setWidth(ref.current.offsetWidth);
  }, [stack, metricType, unit]);
  
  const left = `clamp(8px, calc(${xPct}% + 4px), calc(100% - ${width + 8}px))`;
  const unitLabel = unit === "cost" ? "" : " tokens";
  
  return (
    <div
      ref={ref}
      className="absolute top-2 pointer-events-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[10px] shadow-lg z-10"
      style={{ left, minWidth: 160 }}
    >
      <div className="text-[var(--color-text-muted)] mb-1">
        {formatBucketLabel(stack.ts, true, bucket)}
      </div>
      <div className="text-[var(--color-text)] font-semibold mb-1 tabular-nums">
        {fmt(stack.total)}{unitLabel}
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
  for (let i = 0; i <= count; i++) ticks.push(step * i);
  return ticks;
}

function formatBucketLabel(ts: number, full = false, bucket?: Bucket): string {
  const d = new Date(ts * 1000);
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
