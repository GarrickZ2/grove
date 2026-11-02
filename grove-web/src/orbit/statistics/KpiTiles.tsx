import type { ReactNode } from "react";
import type { KpiData } from "../../api/statistics";
import type { AverageRates } from "../../components/Stats/components/pricing";
import { formatCost, formatDuration, formatNumber, formatTokens } from "../../components/Stats/formatters";
import { RANGE_SECS, kpiSplit, kpiValue, type MetricType, type RangeId, type Unit } from "../../components/Stats/statsModel";
import { METRIC_LABEL, deltaOf, rateLabel, tokenColor, type Delta } from "./statisticsView";

interface KpiTilesProps {
  current?: KpiData;
  previous?: KpiData;
  range: RangeId;
  metric: MetricType;
  unit: Unit;
  averageRates: AverageRates;
  dark: boolean;
}

/** Headline numbers for the window, each against the previous window of equal length. */
export function KpiTiles({ current, previous, range, metric, unit, averageRates, dark }: KpiTilesProps) {
  const fmt = unit === "cost" ? formatCost : formatTokens;
  const value = kpiValue(current, metric, unit, averageRates);
  const prevValue = kpiValue(previous, metric, unit, averageRates);
  const turns = current?.turns ?? 0;
  const prevTurns = previous?.turns ?? 0;
  const perTurn = turns > 0 ? value / turns : 0;
  const prevPerTurn = prevTurns > 0 ? prevValue / prevTurns : 0;
  const rate = rateLabel(RANGE_SECS[range]);
  const vs = `vs the previous ${range}`;
  const noun = unit === "cost" ? "cost" : "tokens";

  const split = current ? kpiSplit(current, unit, averageRates) : null;
  const splitTotal = split ? split.input + split.cached + split.output : 0;
  const parts = split && splitTotal > 0
    ? (["input", "cached", "output"] as const).map((kind) => ({ kind, value: split[kind], color: tokenColor(kind, dark) }))
    : [];

  return (
    <section className="ostat-kpis" aria-label="Summary">
      <Tile
        index={0}
        label={`${METRIC_LABEL[metric]} ${noun}`}
        value={current ? fmt(value) : "—"}
        delta={current ? deltaOf(value, prevValue) : null}
        vs={vs}
        foot={parts.length ? (
          <>
            <span className="ostat-split" aria-hidden="true">
              {parts.map((part) => <i key={part.kind} style={{ flexGrow: (part.value / splitTotal) * 100, background: part.color }} />)}
            </span>
            <span className="ostat-split-key">
              {parts.map((part) => (
                <span key={part.kind} title={fmt(part.value)}>
                  <i style={{ background: part.color }} />
                  {part.kind === "cached" ? "Cache" : part.kind === "input" ? "In" : "Out"} {Math.round((part.value / splitTotal) * 100)}%
                </span>
              ))}
            </span>
          </>
        ) : <span>{current ? "No turns in this range" : " "}</span>}
      />
      <Tile
        index={1}
        label="Prompt turns"
        value={current ? formatNumber(turns) : "—"}
        delta={current ? deltaOf(turns, prevTurns) : null}
        vs={vs}
        foot={<span>{formatNumber(Math.round((turns / rate.divisor) * 10) / 10)} per {rate.per}</span>}
      />
      <Tile
        index={2}
        label="Agent time"
        title="Sum of each turn’s end − start; overlapping turns count twice"
        value={current ? formatDuration(current.agent_compute_secs) : "—"}
        delta={current ? deltaOf(current.agent_compute_secs, previous?.agent_compute_secs) : null}
        vs={vs}
        foot={current && turns > 0 ? (
          <span title={deltaTitle(deltaOf(current.avg_duration_secs, previous?.avg_duration_secs), "Average turn", vs)}>
            avg {formatDuration(current.avg_duration_secs, true)} · p50 {formatDuration(current.p50_duration_secs, true)} a turn
          </span>
        ) : <span>sum of turn durations</span>}
      />
      <Tile
        index={3}
        label={unit === "cost" ? "Cost per turn" : "Tokens per turn"}
        value={current ? fmt(perTurn) : "—"}
        delta={current ? deltaOf(perTurn, prevPerTurn) : null}
        vs={vs}
        foot={<span>{prevTurns > 0 ? `${fmt(prevPerTurn)} the previous ${range}` : `${METRIC_LABEL[metric].toLowerCase()} ${noun}, averaged`}</span>}
      />
    </section>
  );
}

function deltaTitle(delta: Delta | null, what: string, vs: string) {
  return delta ? `${what}: ${delta.text} ${vs}` : undefined;
}

function Tile({ index, label, title, value, delta, vs, foot }: { index: number; label: string; title?: string; value: string; delta: Delta | null; vs: string; foot: ReactNode }) {
  return (
    <div className="ostat-kpi" style={{ animationDelay: `${40 + index * 40}ms` }} title={title}>
      <div className="ostat-kpi-top">
        <span>{label}</span>
        {delta ? (
          <em className={`ostat-delta${delta.dir > 0 ? " is-up" : delta.dir < 0 ? " is-down" : ""}`} title={`${delta.text} ${vs}`}>
            {delta.text}
          </em>
        ) : null}
      </div>
      {/* Keyed so a new value lands with a small settle instead of a silent swap. */}
      <b key={value}>{value}</b>
      <div className="ostat-kpi-foot">{foot}</div>
    </div>
  );
}
