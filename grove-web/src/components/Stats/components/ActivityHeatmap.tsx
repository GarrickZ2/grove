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
          <Swatch level={0} />
          <Swatch level={1} />
          <Swatch level={2} />
          <Swatch level={3} />
          <Swatch level={4} />
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
            <HourStrip cellMap={cellMap} />
          ) : (
            <WeekGrid cellMap={cellMap} />
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

function WeekGrid({ cellMap }: { cellMap: Map<string, number> }) {
  return (
    <div className="flex flex-col flex-1 gap-[3px] min-h-0">
      {/* Rows: weekday — each row stretches to fill available card height. */}
      {WEEKDAYS.map((wd, dayIdx) => (
        <div key={wd} className="flex flex-1 items-stretch gap-2 min-h-0">
          <span className="w-7 self-center text-[10px] text-[var(--color-text-muted)] tabular-nums">
            {wd}
          </span>
          <div className="flex-1 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px]">
            {Array.from({ length: 24 }, (_, hr) => {
              const v = cellMap.get(`${dayIdx}-${hr}`) ?? 0;
              return (
                <Cell
                  key={hr}
                  v={v}
                  title={`${wd} ${String(hr).padStart(2, "0")}:00 — ${v} turns`}
                />
              );
            })}
          </div>
        </div>
      ))}
      {/* Hour ticks under the grid — natural height. */}
      <div className="flex items-center gap-2 mt-1 shrink-0">
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

function HourStrip({ cellMap }: { cellMap: Map<string, number> }) {
  return (
    <div className="flex-1 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px] min-h-0">
      {Array.from({ length: 24 }, (_, hr) => {
        const v = cellMap.get(String(hr)) ?? 0;
        return (
          <Cell
            key={hr}
            v={v}
            title={`${String(hr).padStart(2, "0")}:00 — ${v} turns`}
          />
        );
      })}
    </div>
  );
}

/**
 * Absolute intensity scale. Tuned for grove's actual usage where a busy
 * hour sees 10-30 turns; relative-max scaling made 4 turns look like
 * peak activity which over-promised in light usage.
 *
 *   0     → empty (no activity)
 *   1-4   → faint
 *   5-14  → light
 *   15-29 → medium
 *   ≥30   → heavy
 */
function intensityLevel(v: number): 0 | 1 | 2 | 3 | 4 {
  if (v <= 0) return 0;
  if (v < 5) return 1;
  if (v < 15) return 2;
  if (v < 30) return 3;
  return 4;
}

const LEVEL_OPACITY = ["0", "22", "45", "70", "100"]; // pct

function Cell({ v, title }: { v: number; title: string }) {
  const lvl = intensityLevel(v);
  return (
    <div
      title={title}
      className="rounded-sm w-full h-full min-h-[8px]"
      style={{
        backgroundColor:
          lvl === 0
            ? "var(--color-bg-tertiary)"
            : `color-mix(in srgb, var(--color-highlight) ${LEVEL_OPACITY[lvl]}%, transparent)`,
      }}
    />
  );
}

function Swatch({ level }: { level: 0 | 1 | 2 | 3 | 4 }) {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-sm"
      style={{
        backgroundColor:
          level === 0
            ? "var(--color-bg-tertiary)"
            : `color-mix(in srgb, var(--color-highlight) ${LEVEL_OPACITY[level]}%, transparent)`,
      }}
    />
  );
}
