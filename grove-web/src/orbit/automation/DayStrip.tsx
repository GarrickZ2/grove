import { useState } from "react";
import type { DayTimeline } from "./automationView";
import { dayLine } from "./automationView";

interface DayStripProps {
  timeline: DayTimeline;
  /** Selects the Automation a mark belongs to. */
  onPick: (automationId: string) => void;
  selectedId: string | null;
}

/** Recorded runs (left of now) and the next scheduled ones (right) on a rolling 24h lane. */
export function DayStrip({ timeline, onPick, selectedId }: DayStripProps) {
  const [hot, setHot] = useState<string | null>(null);
  return (
    <section className="oau-day oui-rise" style={{ animationDelay: "50ms" }} aria-label="Timeline">
      <div className="oau-day-head">
        <b>Timeline</b>
        <span>{dayLine(timeline)}</span>
      </div>
      <div className="oau-lane" onMouseLeave={() => setHot(null)}>
        <span className="oau-past" style={{ width: `${timeline.nowX}%` }} />
        {timeline.marks.map((mark, index) => (
          <button
            key={mark.key}
            type="button"
            className={`oau-mark is-${mark.tone}${mark.managed && mark.tone === "ok" ? " is-managed" : ""}${hot === mark.key || mark.automationId === selectedId ? " is-hot" : ""}`}
            style={{ left: `${mark.x}%`, animationDelay: `${200 + index * 50}ms` }}
            aria-label={mark.label}
            onMouseEnter={() => setHot(mark.key)}
            onFocus={() => setHot(mark.key)}
            onBlur={() => setHot(null)}
            onClick={() => onPick(mark.automationId)}
          >
            {hot === mark.key ? <span className={`oau-tip${mark.x < 12 ? " is-start" : mark.x > 88 ? " is-end" : ""}`} role="tooltip">{mark.label}</span> : null}
          </button>
        ))}
        <span className="oau-now" style={{ left: `${timeline.nowX}%` }} aria-hidden="true" />
      </div>
      <div className="oau-hours" aria-hidden="true">
        {/* A tick right next to "Now" would collide with its label. */}
        {timeline.ticks.filter((tick) => Math.abs(tick.x - timeline.nowX) > 4).map((tick) => <span key={tick.x} style={{ left: `${tick.x}%` }}>{tick.label}</span>)}
        <span className="oau-hours-now" style={{ left: `${timeline.nowX}%` }}>Now</span>
      </div>
    </section>
  );
}
