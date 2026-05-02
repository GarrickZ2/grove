/**
 * Lightweight perf-mark wrappers callable from business code.
 *
 * In a non-perf build the `if (import.meta.env.MODE === "perf")` check is a
 * compile-time constant `false`, so vite/rollup eliminate every call site to
 * a no-op (the branch body is never emitted into the chunk). Business code
 * can therefore sprinkle `perfMark("setMessages")` freely without paying for
 * it in production.
 */

export function perfMark(name: string, detail?: Record<string, unknown>): void {
  if (import.meta.env.MODE === "perf") {
    try {
      performance.mark(name, detail ? { detail } : undefined);
    } catch {
      // performance.mark with detail is widely supported but guard anyway.
    }
  }
}

export function perfMeasure(
  name: string,
  startMark: string,
  endMark?: string,
): void {
  if (import.meta.env.MODE === "perf") {
    try {
      performance.measure(name, startMark, endMark);
    } catch {
      // Marks may not exist if caller forgot to set them; swallow.
    }
  }
}
