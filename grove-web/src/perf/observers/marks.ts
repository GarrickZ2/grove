import { perfRecorder } from "../recorder";

/**
 * Capture user-defined performance.mark/measure calls (from perfMark/perfMeasure)
 * so they show up in the perf panel timeline alongside long tasks etc.
 */
export function installMarkObserver(): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  let markObs: PerformanceObserver | null = null;
  let measureObs: PerformanceObserver | null = null;
  try {
    markObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        perfRecorder.record({
          ts: e.startTime,
          kind: "mark",
          name: e.name,
          duration: 0,
          meta: (e as PerformanceMark).detail
            ? { detail: (e as PerformanceMark).detail }
            : undefined,
        });
      }
    });
    markObs.observe({ type: "mark", buffered: true });
  } catch {
    // ignore
  }
  try {
    measureObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        perfRecorder.record({
          ts: e.startTime,
          kind: "measure",
          name: e.name,
          duration: e.duration,
        });
      }
    });
    measureObs.observe({ type: "measure", buffered: true });
  } catch {
    // ignore
  }
  return () => {
    markObs?.disconnect();
    measureObs?.disconnect();
  };
}
