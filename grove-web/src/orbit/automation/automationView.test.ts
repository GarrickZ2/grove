import { describe, expect, it } from "vitest";
import type { Automation, AutomationRun } from "../../api/automations";
import { buildDayTimeline, dayLine, footLine, nextRunBadge, runExcerpt, scheduleText, sessionTargetText, taskTargetText } from "./automationView";

const NOW = new Date(2030, 5, 12, 14, 0).getTime();
const sec = (h: number, m = 0, day = 12) => Math.floor(new Date(2030, 5, day, h, m).getTime() / 1000);
const auto = (patch: Partial<Automation> = {}) => ({
  id: "a1", project: "p", name: "Standup", enabled: true, handler_key: "builtin.task_prompt",
  agent_config: { source: "default" }, task_mode: "existing", task_id: "_local", session_mode: "new",
  prompt: "x", schedule_cron: "0 9 * * *", created_at: 0, updated_at: 0, ...patch,
}) as Automation;
const run = (id: string, at: number, status: string, patch: Partial<AutomationRun> = {}) => ({
  id, automation_id: "a1", trigger_kind: "cron", prompt_snapshot: "", agent_config_snapshot: { source: "default" },
  input: {}, execution_scope: "", triggered_at: at, status, ...patch,
}) as AutomationRun;

describe("nextRunBadge", () => {
  it("counts down to the next run and names the day", () => {
    expect(nextRunBadge(auto({ next_run_at: sec(23) }), NOW)).toEqual({ value: "9h", caption: "today" });
    expect(nextRunBadge(auto({ next_run_at: sec(14, 46) }), NOW)).toEqual({ value: "46m", caption: "today" });
    expect(nextRunBadge(auto({ next_run_at: sec(9, 0, 13) }), NOW)).toEqual({ value: "19h", caption: "tomorrow" });
    // Further out it names the weekday, in English whatever the system locale.
    expect(nextRunBadge(auto({ next_run_at: sec(9, 0, 15) }), NOW)?.caption).toBe("Sat");
  });
  it("shows paused and finished rows instead of a countdown", () => {
    expect(nextRunBadge(auto({ enabled: false, next_run_at: sec(23) }), NOW)).toEqual({ value: "Off", caption: "paused" });
    expect(nextRunBadge(auto({ enabled: false, run_once_at: 1_577_836_800 }), NOW)?.value).toBe("Ended");
    expect(nextRunBadge(auto(), NOW)).toBeNull();
  });
});

describe("footLine", () => {
  it("explains whether and when the row runs", () => {
    expect(footLine(auto({ enabled: false }), null)).toMatch(/^Off/);
    expect(footLine(auto({ enabled: false }), "Memory")).toBe("Paused · turn it on in Memory");
    expect(footLine(auto({ event_triggers: ["task.merged"] }), null)).toBe("On · runs when its event fires");
    expect(footLine(auto({ next_run_at: Math.floor(Date.now() / 1000) + 7200 }), "Memory")).toBe("Next run in 2h");
  });
});

describe("target labels", () => {
  it("names tasks and sessions the way users recognise them", () => {
    expect(taskTargetText(auto(), () => undefined)).toBe("Local task");
    expect(taskTargetText(auto({ task_id: "t-12345678" }), (id) => (id === "t-12345678" ? "Fix login" : undefined))).toBe("Fix login");
    expect(taskTargetText(auto({ task_id: "t-12345678" }), () => undefined)).toBe("Task t-123456…");
    expect(taskTargetText(auto({ task_mode: "new", task_template: { name: "Deps" } }), () => undefined)).toBe("New task · Deps");
    expect(sessionTargetText(auto(), null)).toBe("New session each run");
    expect(sessionTargetText(auto({ session_mode: "existing", chat_id: "c1" }), "Review sweep")).toBe("Review sweep");
  });
});

describe("runExcerpt", () => {
  it("summarises what a run produced or why it stopped", () => {
    expect(runExcerpt(run("r", 0, "success", { agent_response: "\n  Opened 1 task\nmore" }))).toBe("Opened 1 task");
    expect(runExcerpt(run("r", 0, "success"))).toMatch(/tools only/);
    expect(runExcerpt(run("r", 0, "failed", { phase: "spawn_acp", error: "timeout" }))).toBe("spawn_acp · timeout");
    expect(runExcerpt(run("r", 0, "running"))).toBeNull();
  });
});

describe("buildDayTimeline", () => {
  it("shows the last 12h of runs and the next 12h of scheduled runs, now in the middle", () => {
    const a = auto({ next_run_at: sec(23) });
    // Tomorrow 01:00 is inside the next 12h, so it shows even though it's another day.
    const b = auto({ id: "b", name: "Memory", handler_key: "grove.memory.organization", next_run_at: sec(1, 0, 13) });
    const runs = new Map([
      ["a1", [run("r1", sec(9), "success", { completed_at: sec(9) + 41 }), run("r0", sec(1, 0, 12), "success")]],
      ["b", [run("r2", sec(2, 30), "failed"), run("r3", sec(13, 59), "running")]],
    ]);
    const t = buildDayTimeline([a, b], runs, (x) => x.handler_key !== "builtin.task_prompt", NOW);
    expect(t.marks.map((m) => [m.key, m.tone])).toEqual([["r2", "fail"], ["r1", "ok"], ["r3", "live"], ["next-a1", "next"], ["next-b", "next"]]);
    expect(t.marks[0].managed).toBe(true);
    expect(t.marks[1].label).toMatch(/Standup · done in 41s$/);
    expect(t.nowX).toBeCloseTo(50);
    expect(t.ticks[0].label).toBe("03:00");
    expect(t.ticks.map((tick) => tick.label)).toContain("00:00");
    expect([t.ran, t.failed, t.live, t.upcoming]).toEqual([3, 1, 1, 2]);
    expect(dayLine(t)).toMatch(/^3 runs in the last 12h · 1 running · 1 failed · next at 23:00$/);
  });
  it("reads plainly when nothing happened or is coming", () => {
    const t = buildDayTimeline([auto({ enabled: false, next_run_at: sec(23) })], new Map(), () => false, NOW);
    expect(t.marks).toEqual([]);
    expect(dayLine(t)).toBe("No runs in the last 12h · nothing scheduled in the next 12h");
  });
});

describe("scheduleText", () => {
  it("describes cron, its window and one-time runs with English dates", () => {
    expect(scheduleText(auto(), NOW)).toBe("At 09:00");
    expect(scheduleText(auto({ starts_at: sec(0, 0, 20), ends_at: sec(0, 0, 30) }), NOW)).toBe("At 09:00, from Jun 20, until Jun 30");
    expect(scheduleText(auto({ run_once_at: sec(16, 5, 14) }), NOW)).toBe("Once on Jun 14 16:05");
  });
});
