import cronstrue from "cronstrue";
export function describeSchedule(cron: string): string { try { return cronstrue.toString(cron, { use24HourTimeFormat: true }); } catch { return cron; } }
export function formatRelative(d: Date): string {
  const now = Date.now();
  const diffMs = d.getTime() - now;
  const absMs = Math.abs(diffMs);
  const isFuture = diffMs > 0;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (absMs < min) return isFuture ? "in <1m" : "<1m ago";
  if (absMs < hour) {
    const m = Math.round(absMs / min);
    return isFuture ? `in ${m}m` : `${m}m ago`;
  }
  if (absMs < day) {
    const h = Math.round(absMs / hour);
    return isFuture ? `in ${h}h` : `${h}h ago`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
