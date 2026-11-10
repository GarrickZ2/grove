// Pure view model for Orbit's Automation page: list countdowns, the footer
// line, target labels and the "Today" timeline. Everything derives from the
// Automation rows and their recorded runs; nothing here is estimated.

import type { Automation, AutomationRun } from "../../api/automations";
import { describeSchedule, scheduleEnded } from "../../components/Automation/automationFormat";
import { isRunInFlight } from "../../components/Automation/automationModel";
import { formatClock, formatDate, formatDay, relativeText } from "../ui/format";
import type { StatusTone } from "../ui/Surface";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const clock = (ms: number) => formatClock(ms);

/** The schedule in words, with its window or one-time date in English. */
export function scheduleText(a: Pick<Automation, "schedule_cron" | "run_once_at" | "starts_at" | "ends_at">, now: number = Date.now()): string {
  if (a.run_once_at) return `Once on ${formatDay(a.run_once_at * 1000, { now })} ${formatClock(a.run_once_at * 1000)}`;
  const base = describeSchedule(a.schedule_cron);
  const window = [
    a.starts_at ? `from ${formatDay(a.starts_at * 1000, { now })}` : null,
    a.ends_at ? `until ${formatDay(a.ends_at * 1000, { now })}` : null,
  ].filter(Boolean).join(", ");
  return window ? `${base}, ${window}` : base;
}

/** Right-hand column of a list row: a compact countdown plus its caption. */
export function nextRunBadge(a: Automation, now: number): { value: string; caption: string } | null {
  if (scheduleEnded(a)) return { value: "Ended", caption: a.run_once_at ? "ran once" : "window over" };
  if (!a.enabled) return { value: "Off", caption: "" };
  if (!a.next_run_at) return null;
  const at = a.next_run_at * 1000;
  const diff = Math.max(0, at - now);
  const value = diff < HOUR ? `${Math.max(1, Math.round(diff / MIN))}m` : diff < DAY ? `${Math.round(diff / HOUR)}h` : `${Math.round(diff / DAY)}d`;
  const dayDiff = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  const caption = dayDiff <= 0 ? "today" : dayDiff === 1 ? "tomorrow" : formatDate(at, { weekday: "short" });
  return { value, caption };
}

/** Footer status next to the enable toggle; the toggle (or chip) already says on / off. */
export function footLine(a: Automation, managedBy: string | null): string {
  if (scheduleEnded(a)) return a.run_once_at ? "Done" : "Ended";
  if (!a.enabled) return "";
  if (a.next_run_at) return `Next run ${relativeText(a.next_run_at * 1000)}`;
  return a.event_triggers?.length ? "Runs when its event fires" : managedBy ? `Scheduled by ${managedBy}` : "";
}

export function taskTargetText(a: Automation, taskName: (id: string) => string | undefined): string {
  if (a.task_mode === "new") return a.task_template?.name ? `New task · ${a.task_template.name}` : "New task each run";
  if (a.task_id === "_local") return "Local task";
  const id = a.task_id ?? "";
  return taskName(id) ?? (id.length >= 8 ? `Task ${id.slice(0, 8)}…` : `Task ${id}`);
}

export function sessionTargetText(a: Automation, chatTitle: string | null): string {
  if (a.session_mode === "new") return a.session_template?.title ? `New · ${a.session_template.title}` : "New session each run";
  if (a.session_mode === "buddy_active") return "Buddy’s active session";
  if (chatTitle) return chatTitle;
  const id = a.chat_id ?? "";
  return id ? (id.length >= 12 ? `${id.slice(0, 12)}…` : id) : "Existing session";
}

/** Agent key for the "Agent" pick, when the row itself names one. */
export function agentKeyOf(a: Automation, chatAgent: string | null): string | null {
  if (a.session_mode === "new") return a.session_template?.agent || a.agent_config.agent_id || null;
  return chatAgent ?? a.agent_config.agent_id ?? null;
}

export type RunTone = "ok" | "fail" | "live" | "wait" | "off";

/** Run tone → status dot; running is the page's sky blue, like the Today strip. */
export const RUN_DOT: Record<RunTone, StatusTone> = { ok: "ok", fail: "fail", live: "info", wait: "waiting", off: "off" };

export function runTone(status: string): RunTone {
  if (status === "success") return "ok";
  if (isRunInFlight({ status })) return "live";
  if (status === "waiting") return "wait";
  if (status === "cancelled") return "off";
  return "fail";
}

export function runLabel(status: string): string {
  switch (status) {
    case "success": return "Done";
    case "queued": return "Queued";
    case "running": return "Running";
    case "waiting": return "Waiting for input";
    case "cancelled": return "Cancelled";
    default: return "Failed";
  }
}

/** One-line excerpt of what a run produced (or why it stopped). */
export function runExcerpt(run: AutomationRun): string | null {
  const first = (text?: string) => text?.trim().split("\n").find((line) => line.trim())?.trim() ?? null;
  if (run.status === "success") return first(run.agent_response) ?? "Ran tools only — no text response";
  if (run.status === "failed") return [run.phase, first(run.error) ?? "Unknown failure"].filter(Boolean).join(" · ");
  if (run.status === "cancelled") return first(run.error);
  return null;
}

export function triggerText(kind: string): string {
  return kind === "cron" ? "schedule" : kind;
}

export interface DayMark {
  key: string;
  automationId: string;
  /** Position across the day, 0–100. */
  x: number;
  tone: RunTone | "next";
  managed: boolean;
  label: string;
}

export interface DayTimeline {
  marks: DayMark[];
  /** Position of "now", 0–100 (the middle of the window). */
  nowX: number;
  /** Clock-hour labels every 3h across the window. */
  ticks: { x: number; label: string }[];
  ran: number;
  failed: number;
  live: number;
  upcoming: number;
  nextAt: number | null;
}

/** Hours shown on each side of "now". */
export const TIMELINE_HALF_HOURS = 12;
const TICK_HOURS = 3;

/**
 * A rolling window centred on now: runs recorded in the last 12h on the left,
 * every enabled row's next run within the next 12h on the right — so a run
 * just after midnight still shows up in the evening.
 */
export function buildDayTimeline(
  automations: Automation[],
  runs: Map<string, AutomationRun[]>,
  isManaged: (a: Automation) => boolean,
  now: number,
): DayTimeline {
  const span = TIMELINE_HALF_HOURS * 2 * HOUR;
  const start = now - TIMELINE_HALF_HOURS * HOUR;
  const end = now + TIMELINE_HALF_HOURS * HOUR;
  const pos = (ms: number) => Math.min(100, Math.max(0, ((ms - start) / span) * 100));
  const marks: DayMark[] = [];
  let ran = 0, failed = 0, live = 0, upcoming = 0;
  let nextAt: number | null = null;
  for (const a of automations) {
    const managed = isManaged(a);
    for (const run of runs.get(a.id) ?? []) {
      const at = run.triggered_at * 1000;
      if (at < start || at > now) continue;
      const tone = runTone(run.status);
      if (tone === "live") live += 1;
      else if (tone === "fail") failed += 1;
      ran += 1;
      const took = run.completed_at ? ` in ${Math.max(1, Math.round(run.completed_at - run.triggered_at))}s` : "";
      marks.push({ key: run.id, automationId: a.id, x: pos(at), tone, managed, label: `${clock(at)} · ${a.name} · ${runLabel(run.status).toLowerCase()}${tone === "ok" ? took : ""}` });
    }
    if (a.enabled && a.next_run_at) {
      const at = a.next_run_at * 1000;
      if (at > now && at <= end) {
        upcoming += 1;
        if (nextAt === null || at < nextAt) nextAt = at;
        marks.push({ key: `next-${a.id}`, automationId: a.id, x: pos(at), tone: "next", managed, label: `${clock(at)} · ${a.name} · ${relativeText(at, now)}` });
      }
    }
  }
  marks.sort((l, r) => l.x - r.x);
  const ticks: DayTimeline["ticks"] = [];
  const first = new Date(start);
  first.setMinutes(0, 0, 0);
  first.setHours(Math.ceil(first.getHours() / TICK_HOURS) * TICK_HOURS);
  for (let at = first.getTime(); at <= end; at += TICK_HOURS * HOUR) {
    if (at >= start) ticks.push({ x: pos(at), label: clock(at) });
  }
  return { marks, nowX: pos(now), ticks, ran, failed, live, upcoming, nextAt };
}

export function dayLine(t: DayTimeline): string {
  const parts: string[] = [];
  // An empty lane says "nothing ran, nothing coming" by itself.
  if (t.ran) parts.push(`${t.ran} ${t.ran === 1 ? "run" : "runs"} in the last ${TIMELINE_HALF_HOURS}h`);
  if (t.live) parts.push(`${t.live} running`);
  if (t.failed) parts.push(`${t.failed} failed`);
  if (t.nextAt) parts.push(`next at ${clock(t.nextAt)}`);
  return parts.join(" · ");
}
