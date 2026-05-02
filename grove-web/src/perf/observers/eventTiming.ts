import { perfRecorder } from "../recorder";

// Only report events at least this slow. The Event Timing API quantises
// duration to 8ms buckets for privacy, so anything below ~50ms is noisy
// and not a real perceptible-jank signal.
const SLOW_EVENT_THRESHOLD_MS = 50;

// Drop passive pointer/hover noise — these fire on every cursor movement
// across element boundaries and aren't user-perceptible interactions.
const IGNORED_EVENT_TYPES = new Set([
  "mouseover",
  "mouseout",
  "mousemove",
  "pointerover",
  "pointerout",
  "pointermove",
  "mouseenter",
  "mouseleave",
  "pointerenter",
  "pointerleave",
]);

export function installEventTimingObserver(): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEventTiming;
        if (e.duration < SLOW_EVENT_THRESHOLD_MS) continue;
        if (IGNORED_EVENT_TYPES.has(e.name)) continue;
        perfRecorder.record({
          ts: e.startTime,
          kind: "event",
          name: e.name,
          duration: e.duration,
          meta: {
            processingStart: e.processingStart,
            processingEnd: e.processingEnd,
            interactionId: (e as PerformanceEventTiming & { interactionId?: number }).interactionId,
            target: (e.target as Element | null)?.tagName ?? null,
          },
        });
      }
    });
    observer.observe({ type: "event", buffered: true, durationThreshold: SLOW_EVENT_THRESHOLD_MS } as PerformanceObserverInit);
  } catch {
    return () => {};
  }
  return () => observer?.disconnect();
}
