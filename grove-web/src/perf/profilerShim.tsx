import type { ReactNode } from "react";
import { PerfProfiler } from "./PerfProfiler";

/**
 * Business-code-friendly wrapper. Always safe to import.
 *
 * In a non-perf build, `import.meta.env.MODE !== "perf"` is a compile-time
 * constant `true`, so rollup eliminates the entire <PerfProfiler> branch
 * (along with its transitive imports of recorder.ts) from the bundle.
 */
export function OptionalPerfProfiler({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}): ReactNode {
  if (import.meta.env.MODE !== "perf") return children;
  return <PerfProfiler id={id}>{children}</PerfProfiler>;
}
