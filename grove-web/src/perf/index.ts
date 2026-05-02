/**
 * Perf monitoring entry point.
 *
 * Only loaded when built via `npm run build:perf` (vite mode === "perf").
 * In any other build, `main.tsx` skips the dynamic import entirely and
 * vite tree-shakes this module out of the production bundle.
 */

import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { perfRecorder } from "./recorder";
import { installLongTaskObserver } from "./observers/longtask";
import { installEventTimingObserver } from "./observers/eventTiming";
import { installMemorySampler } from "./observers/memory";
import { installMarkObserver } from "./observers/marks";
import { installAutoInstrument } from "./autoInstrument";
import { PerfPanel } from "./PerfPanel";

let started = false;

export async function startPerfMonitor(): Promise<void> {
  if (started) return;
  started = true;

  installLongTaskObserver();
  installEventTimingObserver();
  installMemorySampler();
  installMarkObserver();
  installAutoInstrument();
  perfRecorder.startFpsLoop();

  const host = document.createElement("div");
  host.id = "grove-perf-root";
  document.body.appendChild(host);
  createRoot(host).render(createElement(PerfPanel));

  console.log("[grove-perf] monitor started (mode=perf)");
}
