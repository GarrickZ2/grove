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
        // Break down what the browser is telling us:
        //   inputDelay        = browser saw the input → JS handler started
        //   processingTime    = your event handlers ran (incl. sync setStates)
        //   presentationDelay = handlers returned → next frame painted
        // If processingTime dominates, your handler / synchronous render is
        // the culprit. If presentationDelay dominates, layout/paint is.
        const inputDelay = Math.max(0, e.processingStart - e.startTime);
        const processingTime = Math.max(0, e.processingEnd - e.processingStart);
        const presentationDelay = Math.max(
          0,
          e.startTime + e.duration - e.processingEnd,
        );
        perfRecorder.record({
          ts: e.startTime,
          kind: "event",
          name: e.name,
          duration: e.duration,
          meta: {
            inputDelay,
            processingTime,
            presentationDelay,
            interactionId: (e as PerformanceEventTiming & { interactionId?: number }).interactionId,
            target: describeTarget(e.target as Element | null),
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

/**
 * Build a short, human-readable selector for the event target so the timeline
 * row shows WHICH element was clicked, not just "BUTTON".
 */
function describeTarget(el: Element | null): string | null {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  // First class only — full classList becomes spam with Tailwind.
  let cls = "";
  if (el.classList.length > 0) {
    const first = el.classList[0];
    if (first && first.length < 30) cls = `.${first}`;
  }
  // Trim trailing text snippet for buttons / links so "click on Add Project"
  // is recognizable.
  const text = (el.textContent ?? "").trim().slice(0, 32);
  const textPart = text ? ` "${text}"` : "";
  return `${tag}${id}${cls}${textPart}`;
}
