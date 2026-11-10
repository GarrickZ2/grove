import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { BarChart3, Table2 } from "lucide-react";
import type { Bucket } from "../../api/statistics";
import { formatCost, formatNumber, formatTokens } from "../../components/Stats/formatters";
import { BUCKET_OPTIONS, type MetricType, type Unit } from "../../components/Stats/statsModel";
import { Button, Card, Segmented } from "../ui";
import { METRIC_LABEL, niceTicks, slotLabel, xLabelIndices, type ChartModel } from "./statisticsView";

const BUCKET_NOUN: Record<Bucket, string> = { hourly: "hour", daily: "day", weekly: "week", monthly: "month" };
/** Past this many columns bars touch; past DENSE they lose their gap entirely. */
const GAPPED = 96;
const MAX_X_LABELS = 7;

interface UsageCardProps {
  model: ChartModel;
  /** Bucket the shown data was fetched with. */
  dataBucket: Bucket;
  bucket: Bucket;
  allowedBuckets: Bucket[];
  onBucket: (bucket: Bucket) => void;
  metric: MetricType;
  unit: Unit;
}

/** Usage over time: one column per bucket, stacked by agent for Total. */
export function UsageCard({ model, dataBucket, bucket, allowedBuckets, onBucket, metric, unit }: UsageCardProps) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const fmt = unit === "cost" ? formatCost : formatTokens;
  const noun = unit === "cost" ? "cost" : "tokens";
  const { columns, series } = model;
  const solo = model.active === 1 && columns.length > 1 ? columns.find((column) => column.total > 0) : undefined;

  return (
    <Card
      className="ostat-usage oui-rise"
      style={{ animationDelay: "120ms" }}
      aria-label="Usage over time"
      title={`${METRIC_LABEL[metric]} ${noun}`}
      hint={solo ? `all of it ${dataBucket === "hourly" ? "at" : "on"} ${slotLabel(solo.start, dataBucket, false)}` : null}
      actions={(
        <>
          <Segmented
            size="sm"
            ariaLabel="Bucket"
            value={bucket}
            onChange={onBucket}
            options={BUCKET_OPTIONS.map((option) => ({
              value: option.id,
              label: option.label,
              disabled: !allowedBuckets.includes(option.id),
              title: allowedBuckets.includes(option.id) ? undefined : "Not available for this range",
            }))}
          />
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            aria-pressed={view === "table"}
            aria-label={view === "table" ? "Show chart" : "Show table"}
            title={view === "table" ? "Show chart" : "Show table"}
            onClick={() => setView(view === "table" ? "chart" : "table")}
          >
            {view === "table" ? <BarChart3 /> : <Table2 />}
          </Button>
        </>
      )}
    >
      {series.length > 1 ? (
        <div className="ostat-legend" aria-label="Legend">
          {series.map((item) => (
            <span key={item.id}><i style={{ background: item.color }} />{item.label}</span>
          ))}
        </div>
      ) : null}
      {view === "table" ? (
        <UsageTable model={model} bucket={dataBucket} fmt={fmt} />
      ) : (
        <Columns model={model} bucket={dataBucket} fmt={fmt} noun={noun} />
      )}
    </Card>
  );
}

function Columns({ model, bucket, fmt, noun }: { model: ChartModel; bucket: Bucket; fmt: (n: number) => string; noun: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { columns, series } = model;
  const n = columns.length;
  const ticks = niceTicks(model.max);
  const top = ticks[ticks.length - 1];
  const labels = xLabelIndices(n, MAX_X_LABELS);
  const density = n > GAPPED ? " is-dense" : n > 40 ? " is-tight" : "";
  const active = hover != null && hover < n ? hover : null;

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !n) return;
    const index = Math.min(n - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * n)));
    if (index !== hover) setHover(index);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const at = active ?? n - 1;
    const to = event.key === "ArrowLeft" ? at - 1 : event.key === "ArrowRight" ? at + 1 : event.key === "Home" ? 0 : event.key === "End" ? n - 1 : null;
    if (to != null) {
      event.preventDefault();
      setHover(Math.min(n - 1, Math.max(0, to)));
    } else if (event.key === "Escape" && hover != null) {
      event.stopPropagation();
      setHover(null);
    }
  };

  const tip = active != null ? columns[active] : null;
  const tipAlign = active == null ? "" : (active + 0.5) / n < 0.22 ? " is-start" : (active + 0.5) / n > 0.78 ? " is-end" : "";

  return (
    <div className="ostat-plot">
      <div className="ostat-yaxis" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} style={{ bottom: `${(tick / top) * 100}%` }}>{tick === 0 ? "0" : fmt(tick)}</span>
        ))}
      </div>
      <div className="ostat-area">
        <div
          className={`ostat-bars${density}`}
          role="group"
          tabIndex={0}
          aria-label={`${noun} per ${BUCKET_NOUN[bucket]}; arrow keys step through ${n} periods`}
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover((value) => value ?? n - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
          style={{ gridTemplateColumns: `repeat(${Math.max(n, 1)}, minmax(0, 1fr))` } as CSSProperties}
        >
          {ticks.slice(1).map((tick) => (
            <span key={tick} className="ostat-gl" style={{ bottom: `${(tick / top) * 100}%` }} aria-hidden="true" />
          ))}
          {columns.map((column, index) => (
            <div key={index} className={`ostat-col${index === active ? " is-hover" : ""}`} aria-hidden="true">
              <span
                className={`ostat-bar${column.total ? "" : " is-zero"}`}
                style={{ height: column.total ? `max(2px, ${(column.total / top) * 100}%)` : undefined, animationDelay: `${150 + Math.min(index, 30) * 18}ms` }}
              >
                {/* Shares as percentages: raw costs sum below 1 and would leave the bar part-empty. */}
                {column.values.map((value, layer) => (value > 0 ? <i key={series[layer].id} style={{ flexGrow: (value / column.total) * 100, background: series[layer].color }} /> : null))}
              </span>
            </div>
          ))}
          {tip ? (
            <div className={`ostat-tip${tipAlign}`} style={{ left: `${((active! + 0.5) / n) * 100}%` }} role="status">
              <b>{slotLabel(tip.start, bucket, true)}</b>
              {tip.total === 0 && tip.turns === 0 ? (
                <div className="ostat-tip-row"><span className="ostat-tip-key" /><span className="ostat-tip-n">No activity</span></div>
              ) : series.length > 1 ? (
                <>
                  {series.map((item, layer) => (tip.values[layer] > 0 ? (
                    <div key={item.id} className="ostat-tip-row">
                      <span className="ostat-tip-key" style={{ background: item.color }} />
                      <span className="ostat-tip-v">{fmt(tip.values[layer])}</span>
                      <span className="ostat-tip-n">{item.label}</span>
                    </div>
                  ) : null))}
                  {tip.values.filter((value) => value > 0).length > 1 ? <div className="ostat-tip-row is-sum"><span className="ostat-tip-key" /><span className="ostat-tip-v">{fmt(tip.total)}</span><span className="ostat-tip-n">total</span></div> : null}
                </>
              ) : (
                <div className="ostat-tip-row">
                  <span className="ostat-tip-key" style={{ background: series[0]?.color }} />
                  <span className="ostat-tip-v">{fmt(tip.total)}</span>
                  <span className="ostat-tip-n">{noun}</span>
                </div>
              )}
              {tip.total === 0 && tip.turns === 0 ? null : <div className="ostat-tip-row"><span className="ostat-tip-key" /><span className="ostat-tip-v">{formatNumber(tip.turns)}</span><span className="ostat-tip-n">{tip.turns === 1 ? "turn" : "turns"}</span></div>}
            </div>
          ) : null}
          {n > 0 && model.active === 0 ? <div className="ostat-plot-empty">No agent activity in this range</div> : null}
        </div>
        <div className="ostat-xaxis" aria-hidden="true">
          {labels.map((index) => (
            <span
              key={index}
              // Many thin columns: pin the end labels inside the plot instead of centring them.
              className={n > 14 ? (index === 0 ? "is-first" : index === n - 1 ? "is-last" : undefined) : undefined}
              style={{ left: `${((index + 0.5) / n) * 100}%` }}
            >
              {slotLabel(columns[index].start, bucket, false, n > 30)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function UsageTable({ model, bucket, fmt }: { model: ChartModel; bucket: Bucket; fmt: (n: number) => string }) {
  const { columns, series } = model;
  const showSeries = series.length > 1;
  return (
    <div className="ostat-table-wrap oui-scroll">
      <table className="ostat-table">
        <thead>
          <tr>
            <th scope="col">Period</th>
            {showSeries ? series.map((item) => <th key={item.id} scope="col">{item.label}</th>) : null}
            <th scope="col">{showSeries ? "Total" : series[0]?.label ?? "Value"}</th>
            <th scope="col">Turns</th>
          </tr>
        </thead>
        <tbody>
          {[...columns].reverse().map((column) => (
            <tr key={column.start} className={column.total ? undefined : "is-zero"}>
              <th scope="row">{slotLabel(column.start, bucket, true)}</th>
              {showSeries ? column.values.map((value, layer) => <td key={series[layer].id}>{value ? fmt(value) : "—"}</td>) : null}
              <td>{column.total ? fmt(column.total) : "—"}</td>
              <td>{column.turns ? formatNumber(column.turns) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
