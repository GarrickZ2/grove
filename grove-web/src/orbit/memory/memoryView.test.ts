import { describe, expect, it } from "vitest";
import type { AutomationRun } from "../../api/automations";
import type { MemoryConfig } from "../../api/memory";
import { EMPTY_OVERVIEW, configToDraft } from "../../components/Memory/memoryModel";
import {
  activeRunOf, draftProblem, organizeAction, organizerStage, sourceLabel, strengthPct, unseenIds, untilText,
} from "./memoryView";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const nowSeconds = NOW / 1000;

const config: MemoryConfig = {
  project_id: "p",
  enabled: true,
  deep_organization: false,
  pending_log_threshold: 20,
  organization: { id: "org", enabled: true, agent_config: { source: "default", agent_id: "claude" }, schedule_cron: "0 2 * * *", event_triggers: [], next_run_at: nowSeconds + 4 * 3600 + 30 },
};

const run = (id: string, status: string) => ({ id, status, agent_snapshot: "Claude Code" }) as AutomationRun;

describe("organizerStage", () => {
  it("shows the next scheduled run, the early threshold and the last organize", () => {
    const stage = organizerStage(config, { ...EMPTY_OVERVIEW, last_organized_at: nowSeconds - 7200 }, null, NOW);
    expect(stage.title).toBe("Next organize in 4h");
    expect(stage.sub).toContain("or at 20 notes");
    expect(stage.sub).toContain("Last organized");
    expect(stage.busy).toBe(false);
  });

  it("names the agent while a run is organizing pending notes", () => {
    const stage = organizerStage(config, { ...EMPTY_OVERVIEW, in_progress_run_count: 1, active_run_count: 1, log_count: 12 }, run("r", "running"), NOW);
    expect(stage).toMatchObject({ title: "Organizing 12 notes", sub: "Claude Code is merging notes into memories", busy: true });
  });

  it("asks for attention when a run waits, and says when automation is off", () => {
    expect(organizerStage(config, { ...EMPTY_OVERVIEW, active_run_count: 1, waiting_run_count: 1 }, null, NOW).attention).toBe(true);
    expect(organizerStage({ ...config, organization: { ...config.organization, enabled: false } }, EMPTY_OVERVIEW, null, NOW).title).toBe("Organize by hand");
    expect(organizerStage({ ...config, enabled: false }, EMPTY_OVERVIEW, null, NOW).title).toBe("Memory is off");
  });
});

describe("organizeAction", () => {
  it("labels the pending count, and opens a waiting run instead of starting one", () => {
    expect(organizeAction(config, { ...EMPTY_OVERVIEW, log_count: 1 }, false)).toMatchObject({ label: "Organize 1 note", disabled: false });
    expect(organizeAction(config, EMPTY_OVERVIEW, false).label).toBe("Organize now");
    expect(organizeAction(config, { ...EMPTY_OVERVIEW, active_run_count: 1, waiting_run_count: 1 }, false)).toMatchObject({ opensRun: true, disabled: false });
    expect(organizeAction(config, { ...EMPTY_OVERVIEW, in_progress_run_count: 1, active_run_count: 1 }, false)).toMatchObject({ disabled: true, spinning: true });
    expect(organizeAction(config, EMPTY_OVERVIEW, true)).toMatchObject({ label: "Starting…", disabled: true });
  });
});

describe("helpers", () => {
  it("clamps strength to 0–100", () => {
    expect([strengthPct(-3), strengthPct(42.4), strengthPct(140)]).toEqual([0, 42, 100]);
  });

  it("describes time until a future run", () => {
    expect(untilText(nowSeconds + 20, NOW)).toBe("soon");
    expect(untilText(nowSeconds + 25 * 60, NOW)).toBe("in 25m");
    expect(untilText(nowSeconds + 3 * 86400, NOW)).toBe("in 3d");
  });

  it("blocks saving without an organizer or with a broken schedule", () => {
    const draft = configToDraft(config);
    expect(draftProblem(draft)).toBeNull();
    expect(draftProblem({ ...draft, agent_config: { source: "default" } })).toContain("organizer");
    expect(draftProblem({ ...draft, enabled: false, agent_config: { source: "default" } })).toBeNull();
    expect(draftProblem({ ...draft, schedule_cron: "nope" })).toContain("cron");
  });

  it("finds unseen ids, the open run, and readable note sources", () => {
    expect(unseenIds(new Set(["a"]), ["b", "a", "c"])).toEqual(["b", "c"]);
    expect(activeRunOf([run("done", "success"), run("bad", "failed"), run("live", "waiting")])?.id).toBe("live");
    expect(activeRunOf([run("done", "success")])).toBeNull();
    const names = new Map([["t1", "Sidebar resize"]]);
    expect(sourceLabel("t1", names)).toBe("Sidebar resize");
    expect(sourceLabel("_studio_memory_migration", names)).toBe("Legacy Studio import");
    expect(sourceLabel("0123456789abcdef", names)).toBe("Task 01234567…");
  });
});
