import type { AutomationRun } from "../../api/automations";
import type { MemoryConfig, MemoryConfigInput, MemoryOverview } from "../../api/memory";
import { formatNumber, plural } from "../../components/Memory/memoryFormat";
import { describeSchedule, isTerminal, lastOrganizedText, organizePhase, type OrganizePhase } from "../../components/Memory/memoryModel";

/** Orbit Memory copy and derived view state. Pure, so it is unit-tested. */

/** Score runs 0–100 (base score + recalls); the strength bar shows it as a share. */
export function strengthPct(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function countLabel(count: number, singular: string, pluralValue: string) {
  return `${formatNumber(count)} ${plural(count, singular, pluralValue)}`;
}

/** "in 4h" / "in 12m" / "soon" for a future unix-seconds timestamp. */
export function untilText(timestampSeconds: number, nowMs: number) {
  const seconds = timestampSeconds - Math.floor(nowMs / 1000);
  if (seconds < 60) return "soon";
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86400)}d`;
}

/** Cron expressions the backend will accept get a readable description. */
export function isValidSchedule(cron: string) {
  return describeSchedule(cron) !== "Enter a valid cron expression.";
}

export interface OrganizerStage {
  title: string;
  sub: string;
  /** Agent is working (drives the flowing pipeline). */
  busy: boolean;
  /** Needs the person (waiting run). */
  attention: boolean;
}

/** The middle pipeline stage: what the organizer is doing or will do next. */
export function organizerStage(config: MemoryConfig | null, overview: MemoryOverview, activeRun: AutomationRun | null, nowMs: number): OrganizerStage {
  const phase = organizePhase(config, overview, false);
  const last = lastOrganizedText(overview.last_organized_at);
  if (phase === "running") {
    const agent = activeRun?.agent_snapshot;
    return {
      title: overview.log_count > 0 ? `Organizing ${countLabel(overview.log_count, "note", "notes")}` : "Organizing",
      sub: `${agent || "The organizer"} is merging notes into memories`,
      busy: true,
      attention: false,
    };
  }
  if (phase === "waiting") return { title: "Organizer is waiting for you", sub: "Open the run to answer it", busy: false, attention: true };
  if (phase === "stopping") return { title: "Wrapping up a run", sub: last, busy: false, attention: false };
  if (!config?.enabled) return { title: "Memory is off", sub: "Notes aren’t collected and nothing is organized", busy: false, attention: false };
  if (!config.organization.enabled) return { title: "Organize by hand", sub: `Automatic organizing is off · ${last}`, busy: false, attention: false };
  const parts = [describeSchedule(config.organization.schedule_cron)];
  if (config.pending_log_threshold) parts.push(`or at ${countLabel(config.pending_log_threshold, "note", "notes")}`);
  parts.push(last);
  const next = config.organization.next_run_at;
  return {
    title: next ? `Next organize ${untilText(next, nowMs)}` : "Organizing on schedule",
    sub: parts.join(" · "),
    busy: false,
    attention: false,
  };
}

export interface OrganizeAction {
  label: string;
  /** Opens the waiting run instead of starting a new one. */
  opensRun: boolean;
  disabled: boolean;
  spinning: boolean;
}

export function organizeAction(config: MemoryConfig | null, overview: MemoryOverview, runStarting: boolean): OrganizeAction {
  const phase: OrganizePhase = organizePhase(config, overview, runStarting);
  if (phase === "running") return { label: "Organizing…", opensRun: false, disabled: true, spinning: true };
  if (phase === "waiting") return { label: "Open waiting run", opensRun: true, disabled: false, spinning: false };
  if (phase === "stopping") return { label: "Stopping…", opensRun: false, disabled: true, spinning: false };
  if (runStarting) return { label: "Starting…", opensRun: false, disabled: true, spinning: true };
  return {
    label: overview.log_count > 0 ? `Organize ${countLabel(overview.log_count, "note", "notes")}` : "Organize now",
    opensRun: false,
    disabled: phase === "disabled",
    spinning: false,
  };
}

/** The newest run that hasn't reached a terminal state. */
export function activeRunOf(runs: AutomationRun[]) {
  return runs.find((run) => !isTerminal(run.status) && run.status !== "failed") ?? null;
}

/** Why the current draft can't be saved yet, if anything. */
export function draftProblem(draft: MemoryConfigInput): string | null {
  if (draft.enabled && !draft.agent_config.agent_id) return "Choose an organizer agent to turn Memory on.";
  if (!isValidSchedule(draft.schedule_cron)) return "The schedule isn’t a valid cron expression.";
  return null;
}

/** Ids in `ids` that `seen` hasn't had yet (keeps input order). */
export function unseenIds(seen: ReadonlySet<string>, ids: string[]) {
  return ids.filter((id) => !seen.has(id));
}

export function sourceLabel(taskId: string, taskNames: ReadonlyMap<string, string>) {
  if (taskId === "_studio_memory_migration") return "Legacy Studio import";
  if (taskId === "_local") return "Project chat";
  return taskNames.get(taskId) ?? `Task ${taskId.length > 10 ? `${taskId.slice(0, 8)}…` : taskId}`;
}
