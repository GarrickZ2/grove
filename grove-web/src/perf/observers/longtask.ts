import { perfRecorder } from "../recorder";

export function installLongTaskObserver(): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perfRecorder.record({
          ts: entry.startTime,
          kind: "longtask",
          name: entry.name || "longtask",
          duration: entry.duration,
        });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // longtask not supported in this browser; silently skip.
    return () => {};
  }
  return () => observer?.disconnect();
}
