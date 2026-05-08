/**
 * Tiny formatter helpers shared by all Statistics panels. Kept consistent
 * so the dashboard reads as one design language: tokens as `4.2k`,
 * durations as `1h 23m`, deltas as a signed percentage versus the previous
 * window.
 */

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** `secs`: total seconds. `precise` keeps fractional second precision when
 *  the value is small (used by avg-duration-per-turn KPI). */
export function formatDuration(secs: number, precise = false): string {
  if (!isFinite(secs) || secs < 0) return "—";
  if (secs < 1 && precise) return `${secs.toFixed(2)}s`;
  if (secs < 60) return precise ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) {
    const s = Math.round(secs - m * 60);
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m - h * 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

/** Percentage change from `previous` to `current`. Returns Infinity when
 *  previous is 0 and current > 0 (signaled as "new" in the UI). */
export function computeDelta(
  current?: number,
  previous?: number,
): { pct: number | null; direction: 1 | -1 | 0 } {
  if (current == null || previous == null) {
    return { pct: null, direction: 0 };
  }
  if (previous === 0) {
    if (current === 0) return { pct: 0, direction: 0 };
    return { pct: Infinity, direction: 1 };
  }
  const pct = ((current - previous) / previous) * 100;
  const direction = pct > 0.05 ? 1 : pct < -0.05 ? -1 : 0;
  return { pct, direction };
}
