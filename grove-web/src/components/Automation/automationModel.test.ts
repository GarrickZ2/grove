import { describe, expect, it } from "vitest";
import type { Automation } from "../../api/automations";
import { formatDuration, isSystemManagedAutomation, managedAutomationOwner, toUpsert } from "./automationModel";

const row = {
  id: "a1", project: "p", name: "Standup", enabled: true, handler_key: "builtin.task_prompt",
  agent_config: { source: "default" }, task_mode: "existing", task_id: "_local", session_mode: "new",
  session_template: { agent: "claude" }, prompt: "Summarize", schedule_cron: "0 9 * * 1-5",
  event_triggers: ["task.merged"], ends_at: 99, created_at: 1, updated_at: 2, last_run_status: "success",
} as Automation;

describe("automation model", () => {
  it("round-trips every writable field and applies the patch", () => {
    const body = toUpsert(row, { enabled: false });
    expect(body).toMatchObject({ name: "Standup", enabled: false, task_id: "_local", session_template: { agent: "claude" }, event_triggers: ["task.merged"], ends_at: 99 });
    // Read-only server fields never leak into the PUT body.
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("last_run_status");
  });

  it("tells user rows from feature-owned ones", () => {
    expect(isSystemManagedAutomation(row)).toBe(false);
    expect(isSystemManagedAutomation({ ...row, handler_key: "grove.memory.organization" })).toBe(true);
    expect(managedAutomationOwner("grove.memory.organization")).toBe("Memory");
    expect(managedAutomationOwner("grove.other")).toBe("Grove");
  });

  it("formats durations compactly", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(41_000)).toBe("41s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(130_000)).toBe("2m 10s");
  });
});
