import cronstrue from "cronstrue";
import type { ScheduleWindow } from "../../api/automations";

export function describeSchedule(cron: string): string { try { return cronstrue.toString(cron, { use24HourTimeFormat: true }); } catch { return cron; } }

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${formatDate(ts)} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

/// "from Nov 10, until Dec 31" — empty when the recurring schedule is unbounded.
export function describeWindow(window: ScheduleWindow): string {
  const parts: string[] = [];
  if (window.starts_at) parts.push(`from ${formatDate(window.starts_at)}`);
  if (window.ends_at) parts.push(`until ${formatDate(window.ends_at)}`);
  return parts.join(", ");
}

/// Human description of an Automation's full schedule: cron + window, or a one-time run.
export function describeAutomationSchedule(automation: ScheduleWindow & { schedule_cron: string }): string {
  if (automation.run_once_at) return `Once on ${formatDateTime(automation.run_once_at)}`;
  const base = describeSchedule(automation.schedule_cron);
  const window = describeWindow(automation);
  return window ? `${base}, ${window}` : base;
}

/// A bounded schedule that has run its course (the scheduler disables it).
export function scheduleEnded(automation: ScheduleWindow & { enabled: boolean }): boolean {
  if (automation.enabled) return false;
  const now = Date.now() / 1000;
  const end = automation.run_once_at ?? automation.ends_at;
  return end !== undefined && end <= now;
}
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
