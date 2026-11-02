// Pure Automation helpers shared by the Workbench page and Orbit's page.

import type { Automation, AutomationRun, AutomationUpsert } from "../../api/automations";

export const USER_AUTOMATION_HANDLER = "builtin.task_prompt";
export const MEMORY_AUTOMATION_HANDLER = "grove.memory.organization";

/** Rows created by a Grove feature (not the user): read-only here. */
export function isSystemManagedAutomation(automation: Automation): boolean {
  return automation.handler_key !== USER_AUTOMATION_HANDLER;
}

export function managedAutomationOwner(handlerKey: string): string {
  if (handlerKey === MEMORY_AUTOMATION_HANDLER) return "Memory";
  return "Grove";
}

/** Full PUT payload for an existing row, with `patch` applied. The update
 *  endpoint replaces the whole row, so every field must round-trip. */
export function toUpsert(a: Automation, patch: Partial<AutomationUpsert> = {}): AutomationUpsert {
  return {
    name: a.name,
    enabled: a.enabled,
    agent_config: a.agent_config,
    task_mode: a.task_mode,
    task_id: a.task_id,
    task_template: a.task_template,
    session_mode: a.session_mode,
    chat_id: a.chat_id,
    session_template: a.session_template,
    prompt: a.prompt,
    schedule_cron: a.schedule_cron,
    event_triggers: a.event_triggers,
    run_once_at: a.run_once_at,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    ...patch,
  };
}

export function isRunInFlight(run: Pick<AutomationRun, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`;
}
