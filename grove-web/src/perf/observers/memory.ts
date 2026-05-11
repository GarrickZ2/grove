import { perfRecorder } from "../recorder";
import { apiClient } from "../../api/client";

const SAMPLE_INTERVAL_MS = 5000;

interface ChromeMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface SysinfoResponse {
  rss_bytes: number;
  cpu_percent: number;
  pid: number;
}

/**
 * Sample process memory + CPU every 5s.
 *
 * Strategy:
 *   1. If `performance.memory` exists (Chromium), use it for JS heap.
 *   2. Always also try the backend `/api/v1/perf/sysinfo` endpoint, which
 *      reports the Rust process's RSS + CPU%. Available only when Grove
 *      was started with `--features perf-monitor`. A 404 disables further
 *      attempts.
 */
export function installMemorySampler(): () => void {
  const perf = performance as Performance & { memory?: ChromeMemoryInfo };
  let backendDisabled = false;

  const tick = async () => {
    const ts = performance.now();

    // JS heap (Chromium only)
    if (perf.memory) {
      perfRecorder.recordMemory({
        ts,
        usedJSHeapSize: perf.memory.usedJSHeapSize,
        totalJSHeapSize: perf.memory.totalJSHeapSize,
        jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
      });
    }

    // Process RSS + CPU% (any platform, requires perf-monitor backend)
    if (!backendDisabled) {
      try {
        const data = await apiClient.get<SysinfoResponse>("/api/v1/perf/sysinfo");
        // Reuse the memory ring with rss as totalJSHeapSize for chart
        // continuity, and stash CPU% on the same sample so the panel can
        // render both from a single time series.
        perfRecorder.recordMemory({
          ts,
          usedJSHeapSize: data.rss_bytes,
          totalJSHeapSize: data.rss_bytes,
          jsHeapSizeLimit: data.rss_bytes,
        });
        perfRecorder.record({
          ts,
          kind: "memory",
          name: `cpu ${data.cpu_percent.toFixed(1)}% / rss ${(data.rss_bytes / 1024 / 1024).toFixed(0)}MB`,
          duration: data.cpu_percent,
          meta: { rss_bytes: data.rss_bytes, cpu_percent: data.cpu_percent, pid: data.pid },
        });
      } catch (e) {
        // 404 → endpoint not built (no perf-monitor feature); stop polling.
        // Anything else → transient blip, leave backendDisabled alone.
        const status = (e as { status?: number } | null)?.status;
        if (status === 404) backendDisabled = true;
      }
    }
  };

  void tick();
  const id = window.setInterval(() => void tick(), SAMPLE_INTERVAL_MS);
  return () => window.clearInterval(id);
}
