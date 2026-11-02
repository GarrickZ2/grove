import { useMemo, useState } from "react";
import type { HeatmapCell } from "../../api/statistics";
import { formatNumber } from "../../components/Stats/formatters";
import { Card } from "../ui";
import { HEAT_DAYS, buildHeatGrid, heatLevel } from "./statisticsView";

const pad = (n: number) => String(n).padStart(2, "0");
const turnsText = (n: number) => `${formatNumber(n)} ${n === 1 ? "turn" : "turns"}`;

/** Weekday × hour grid of turns (UTC, like the backend's buckets). */
export function HeatmapCard({ cells }: { cells: HeatmapCell[] }) {
  const grid = useMemo(() => buildHeatGrid(cells), [cells]);
  const [hover, setHover] = useState<{ row: number; hour: number } | null>(null);
  const peak = grid.peak;
  const summary = peak ? `${turnsText(grid.total)}; busiest ${peak.day} ${pad(peak.hour)}:00 UTC with ${turnsText(peak.turns)}` : "No turns in this range";

  return (
    <Card className="ostat-heat-card oui-rise" style={{ animationDelay: "200ms" }} aria-label="Activity by weekday and hour" title="When agents work" hint="turns by weekday and hour · UTC">
      <div className="ostat-heat" role="img" aria-label={summary}>
        <div className="ostat-heat-days" aria-hidden="true">
          {HEAT_DAYS.map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="ostat-heat-grid" onPointerLeave={() => setHover(null)}>
          {grid.rows.map((hours, row) => hours.map((turns, hour) => (
            <span
              key={`${row}-${hour}`}
              className={`ostat-cell is-l${heatLevel(turns)}${hover?.row === row && hover.hour === hour ? " is-hover" : ""}`}
              style={{ animationDelay: `${hour * 10 + row * 18}ms` }}
              onPointerEnter={() => setHover({ row, hour })}
            />
          )))}
          {hover ? (
            <span
              className={`ostat-ctip${hover.row < 2 ? " is-below" : ""}${hover.hour < 3 ? " is-start" : hover.hour > 20 ? " is-end" : ""}`}
              style={{ left: `${((hover.hour + 0.5) / 24) * 100}%`, top: `${((hover.row + (hover.row < 2 ? 1 : 0)) / 7) * 100}%` }}
            >
              {HEAT_DAYS[hover.row]} {pad(hover.hour)}:00 · {turnsText(grid.rows[hover.row][hover.hour])}
            </span>
          ) : null}
        </div>
        <span aria-hidden="true" />
        <div className="ostat-heat-hours" aria-hidden="true">
          {[0, 6, 12, 18].map((hour) => <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>{pad(hour)}</span>)}
        </div>
      </div>
      <div className="ostat-heat-foot">
        <span className="ostat-heat-peak">
          {peak ? <>Busiest <b>{peak.day} {pad(peak.hour)}:00</b> · {turnsText(peak.turns)}</> : "No turns in this range"}
        </span>
        <span className="ostat-ramp" aria-hidden="true" title="0 · 1–4 · 5–14 · 15–29 · 30+ turns">
          Less{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`ostat-cell is-l${level}`} />)}More
        </span>
      </div>
    </Card>
  );
}
