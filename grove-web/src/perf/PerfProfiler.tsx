import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { perfRecorder } from "./recorder";

const SLOW_RENDER_THRESHOLD_MS = 8;

const onRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  if (actualDuration < SLOW_RENDER_THRESHOLD_MS) return;
  perfRecorder.record({
    ts: startTime,
    kind: "react-render",
    name: id,
    duration: actualDuration,
    meta: { phase, baseDuration, commitTime },
  });
};

interface PerfProfilerProps {
  id: string;
  children: ReactNode;
}

/**
 * Wrap any subtree to capture per-commit render time.
 * In a non-perf build, `<PerfProfiler>` collapses to a fragment via the
 * shim re-export below — but in practice the perf-build code path imports
 * this file only when MODE === "perf", so the wrap is a no-cost passthrough
 * elsewhere.
 */
export function PerfProfiler({ id, children }: PerfProfilerProps) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
