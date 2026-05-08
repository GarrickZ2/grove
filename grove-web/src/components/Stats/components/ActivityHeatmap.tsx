/**
 * 7×24 weekday × hour heatmap of turns. Cell color intensity scales with
 * turn count; max-intensity cell uses the highlight color.
 *
 * RANGE coupling: when range is `24h`, the data is necessarily within one
 * weekday so we collapse to a 1×24 strip ("activity by hour"). Otherwise
 * the full grid is shown.
 */

import type { HeatmapCell } from "../../../api/statistics";
import { formatNumber } from "../formatters";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ActivityHeatmap({
  cells,
  rangeId,
}: {
  cells: HeatmapCell[];
  rangeId: string;
}) {
  const max = Math.max(...cells.map((c) => c.turns), 1);
  const peak = cells.reduce<HeatmapCell | null>((best, c) => {
    if (!best || c.turns > best.turns) return c;
    return best;
  }, null);

  const collapseToHourStrip = rangeId === "24h";

  // Index for fast lookup.
  const cellMap = new Map<string, number>();
  for (const c of cells) {
    if (collapseToHourStrip) {
      cellMap.set(String(c.hour), (cellMap.get(String(c.hour)) ?? 0) + c.turns);
    } else {
      cellMap.set(`${c.weekday}-${c.hour}`, c.turns);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 h-full flex flex-col min-h-0">
      <div className="flex items-baseline gap-2 mb-3 shrink-0">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          Activity heatmap
        </h2>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          turns by {collapseToHourStrip ? "hour" : "weekday × hour"}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
          <span>less</span>
          <Swatch v={0} max={1} />
          <Swatch v={0.25} max={1} />
          <Swatch v={0.5} max={1} />
          <Swatch v={0.75} max={1} />
          <Swatch v={1} max={1} />
          <span>more</span>
        </span>
      </div>

      {cells.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
          No activity in this range.
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 justify-between">
          {collapseToHourStrip ? (
            <HourStrip cellMap={cellMap} max={max} />
          ) : (
            <WeekGrid cellMap={cellMap} max={max} />
          )}
          {peak && (
            <div className="mt-2 text-[10px] text-[var(--color-text-muted)] tabular-nums">
              Peak {WEEKDAYS[peak.weekday] ?? ""}{" "}
              {String(peak.hour).padStart(2, "0")}:00 ·{" "}
              {formatNumber(peak.turns)} turns
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WeekGrid({
  cellMap,
  max,
}: {
  cellMap: Map<string, number>;
  max: number;
}) {
  return (
    <div className="flex flex-col gap-[3px] min-h-0">
      {/* Rows: weekday */}
      {WEEKDAYS.map((wd, dayIdx) => (
        <div key={wd} className="flex items-center gap-2">
          <span className="w-7 text-[10px] text-[var(--color-text-muted)] tabular-nums">
            {wd}
          </span>
          <div className="flex-1 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px]">
            {Array.from({ length: 24 }, (_, hr) => {
              const v = cellMap.get(`${dayIdx}-${hr}`) ?? 0;
              return (
                <Cell
                  key={hr}
                  v={v}
                  max={max}
                  title={`${wd} ${String(hr).padStart(2, "0")}:00 — ${v} turns`}
                />
              );
            })}
          </div>
        </div>
      ))}
      {/* Hour ticks under the grid */}
      <div className="flex items-center gap-2 mt-1">
        <span className="w-7" />
        <div className="flex-1 grid grid-cols-[repeat(24,minmax(0,1fr))] text-[9px] text-[var(--color-text-muted)] tabular-nums">
          {[0, 4, 8, 12, 16, 20].map((h) => (
            <span
              key={h}
              style={{ gridColumn: `${h + 1} / span 4` }}
              className="text-left"
            >
              {String(h).padStart(2, "0")}:00
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function HourStrip({
  cellMap,
  max,
}: {
  cellMap: Map<string, number>;
  max: number;
}) {
  return (
    <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px]">
      {Array.from({ length: 24 }, (_, hr) => {
        const v = cellMap.get(String(hr)) ?? 0;
        return (
          <Cell
            key={hr}
            v={v}
            max={max}
            title={`${String(hr).padStart(2, "0")}:00 — ${v} turns`}
            tall
          />
        );
      })}
    </div>
  );
}

function Cell({
  v,
  max,
  title,
  tall,
}: {
  v: number;
  max: number;
  title: string;
  tall?: boolean;
}) {
  const intensity = max > 0 ? v / max : 0;
  return (
    <div
      title={title}
      className={`rounded-sm ${tall ? "h-8" : "aspect-square"}`}
      style={{
        backgroundColor:
          intensity === 0
            ? "var(--color-bg-tertiary)"
            : `color-mix(in srgb, var(--color-highlight) ${Math.max(
                12,
                Math.round(intensity * 100),
              )}%, transparent)`,
      }}
    />
  );
}

function Swatch({ v, max }: { v: number; max: number }) {
  const intensity = max > 0 ? v / max : 0;
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-sm"
      style={{
        backgroundColor:
          intensity === 0
            ? "var(--color-bg-tertiary)"
            : `color-mix(in srgb, var(--color-highlight) ${Math.max(
                12,
                Math.round(intensity * 100),
              )}%, transparent)`,
      }}
    />
  );
}
