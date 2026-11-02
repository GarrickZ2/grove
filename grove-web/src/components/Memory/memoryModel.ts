import cronstrue from "cronstrue";
import type { AgentConfigSelection, AutomationRun } from "../../api/automations";
import type { MemoryConfig, MemoryConfigInput, MemoryOverview } from "../../api/memory";
import { formatNumber, plural } from "./memoryFormat";

/** Pure Memory page logic shared by the Workbench page and Orbit. */

export const EMPTY_OVERVIEW: MemoryOverview = {
  entity_count: 0,
  relation_count: 0,
  log_count: 0,
  run_count: 0,
  successful_run_count: 0,
  failed_run_count: 0,
  in_progress_run_count: 0,
  waiting_run_count: 0,
  active_run_count: 0,
  usage: {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_by_currency: {},
  },
};

export const DEFAULT_DRAFT: MemoryConfigInput = {
  enabled: false,
  deep_organization: false,
  pending_log_threshold: null,
  organization_enabled: true,
  agent_config: { source: "default" },
  schedule_cron: "0 2 * * *",
  event_triggers: ["task.finished"],
};

export const TASK_FINISHED_TRIGGER = "task.finished";

export function configToDraft(config: MemoryConfig | null): MemoryConfigInput { return config ? { enabled: config.enabled, deep_organization: config.deep_organization, pending_log_threshold: config.pending_log_threshold, organization_enabled: config.organization.enabled, agent_config: config.organization.agent_config, schedule_cron: config.organization.schedule_cron, event_triggers: config.organization.event_triggers } : { ...DEFAULT_DRAFT, event_triggers: [...DEFAULT_DRAFT.event_triggers] }; }

export function sameMemoryConfig(left: MemoryConfigInput, right: MemoryConfigInput) {
  const stableAgentConfig = (config: AgentConfigSelection) => config.source === "config_options"
    ? { ...config, values: Object.fromEntries(Object.entries(config.values).sort(([a], [b]) => a.localeCompare(b))) }
    : config;
  return left.enabled === right.enabled
    && left.deep_organization === right.deep_organization
    && left.pending_log_threshold === right.pending_log_threshold
    && left.organization_enabled === right.organization_enabled
    && left.schedule_cron === right.schedule_cron
    && JSON.stringify([...left.event_triggers].sort()) === JSON.stringify([...right.event_triggers].sort())
    && JSON.stringify(stableAgentConfig(left.agent_config)) === JSON.stringify(stableAgentConfig(right.agent_config));
}

/** Adds or removes one event trigger, keeping the rest. */
export function withEventTrigger(triggers: string[], trigger: string, on: boolean) {
  const rest = triggers.filter((item) => item !== trigger);
  return on ? [...rest, trigger] : rest;
}

export function compactNumber(value: number) { return new Intl.NumberFormat(undefined, { notation: value >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }

export function formatCosts(costs: Record<string, number>) { const entries = Object.entries(costs); if (!entries.length) return "No reported cost"; return entries.map(([currency, amount]) => `${amount.toFixed(2)} ${currency.toUpperCase()}`).join(" · "); }
export function formatMetricCost(costs: Record<string, number>) {
  const entries = Object.entries(costs);
  if (entries.length === 0) return "—";
  return entries.map(([currency, amount]) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency.toUpperCase(),
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
    }
  }).join(" · ");
}

export function relativeTime(timestampSeconds: number) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestampSeconds);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
export function lastOrganizedText(timestampSeconds?: number) { return timestampSeconds ? `Last organized ${relativeTime(timestampSeconds)} ago` : "Not organized yet"; }

export function describeSchedule(value: string) {
  try {
    return cronstrue.toString(value, { use24HourTimeFormat: true });
  } catch {
    return "Enter a valid cron expression.";
  }
}

export function isTerminal(status: string) { return status === "success" || status === "cancelled"; }
export function isAgentRunning(status: string) { return status === "queued" || status === "running"; }
/** Runs that can still be marked finished by hand. */
export function canFinishRun(status: string) { return ["running", "waiting", "failed"].includes(status); }
export function durationLabel(run: AutomationRun) { const end = run.completed_at ?? Math.floor(Date.now() / 1000); const start = run.started_at ?? run.triggered_at; const seconds = Math.max(0, end - start); if (seconds < 60) return `${seconds}s`; return `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
export function runTitle(run: AutomationRun) {
  if (run.trigger_kind === "manual") return "Manual organization";
  if (["cron", "schedule", "scheduled"].includes(run.trigger_kind)) return "Scheduled organization";
  if (["event", "task", "task.finished"].includes(run.trigger_kind)) return "Task-triggered organization";
  return "Memory organization";
}
/** Memories and relations a finished run changed, from its reported result. */
export function runChanges(result?: Record<string, unknown>) {
  if (!result) return null;
  const memories = ["entities_created", "entities_updated", "entities_deleted"].reduce((sum, key) => sum + Number(result[key] ?? 0), 0);
  return { memories, relations: Number(result.relations_changed ?? 0) };
}

export type MemoryStateTone = "success" | "pending" | "active" | "error" | "muted";

export interface MemoryState {
  label: string;
  tone: MemoryStateTone;
  title: string;
  description: string;
}

/** The headline state of a project's Memory, in priority order. */
export function memoryState(overview: MemoryOverview, enabled: boolean, automaticEnabled: boolean | undefined): MemoryState {
  return overview.in_progress_run_count > 0
    ? {
        label: "Organizing",
        tone: "active",
        title: "Grove is organizing recent project knowledge.",
        description: "Follow the active run to see what is being consolidated.",
      }
    : overview.waiting_run_count > 0
      ? {
          label: "Waiting",
          tone: "pending",
          title: "Memory organization is waiting for you.",
          description: "Open the Run to provide input, guidance, or permission.",
        }
      : !enabled
        ? {
            label: "Disabled",
            tone: "muted",
            title: "Memory is disabled for this project.",
            description: "Enable Memory to collect short-term observations and organize them over time.",
          }
        : overview.log_count > 0
          ? {
              label: `${formatNumber(overview.log_count)} pending`,
              tone: "pending",
              title: `${formatNumber(overview.log_count)} ${plural(overview.log_count, "Memory Log is", "Memory Logs are")} waiting to be organized.`,
              description: overview.failed_run_count > 0
                ? `A previous attempt failed, but these Logs are ready for a new organization run. · ${lastOrganizedText(overview.last_organized_at)}`
                : `${lastOrganizedText(overview.last_organized_at)} · ${automaticEnabled ? "Automatic organization is enabled." : "Automatic organization is paused."}`,
            }
          : overview.failed_run_count > 0
            ? {
                label: "Failed",
                tone: "error",
                title: "A Memory organization attempt failed.",
                description: "Open the Run to review the error, or start a new organization attempt.",
              }
            : {
                label: "Up to date",
                tone: "success",
                title: "No Memory Logs are waiting to be organized.",
                description: `${lastOrganizedText(overview.last_organized_at)} · ${automaticEnabled ? "Automatic organization is enabled." : "Run an organization when you are ready."}`,
              };
}

export type OrganizePhase = "running" | "waiting" | "stopping" | "blocked" | "ready" | "disabled";

/** What the Organize button can do right now. */
export function organizePhase(config: MemoryConfig | null, overview: MemoryOverview, runStarting: boolean, blockedByUnsavedChanges = false): OrganizePhase {
  if (overview.in_progress_run_count > 0) return "running";
  if (overview.active_run_count > 0) return overview.waiting_run_count > 0 ? "waiting" : "stopping";
  if (blockedByUnsavedChanges) return "blocked";
  if (runStarting || !config?.enabled) return "disabled";
  return "ready";
}

/** Counts each tag key once per memory; most common first. */
export function tagCategories(entities: { tags: { key: string }[] }[]) {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    for (const key of new Set(entity.tags.map((tag) => tag.key))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}
