import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "../../api/memory";
import {
  EMPTY_OVERVIEW, configToDraft, memoryState, organizePhase, runChanges, sameMemoryConfig, tagCategories, withEventTrigger,
} from "./memoryModel";

const config: MemoryConfig = {
  project_id: "p",
  enabled: true,
  deep_organization: false,
  pending_log_threshold: 20,
  organization: { id: "org", enabled: true, agent_config: { source: "default", agent_id: "claude" }, schedule_cron: "0 2 * * *", event_triggers: ["task.finished"] },
};

describe("memoryState", () => {
  it("puts a running organization ahead of everything else", () => {
    expect(memoryState({ ...EMPTY_OVERVIEW, in_progress_run_count: 1, waiting_run_count: 1 }, false, true).label).toBe("Organizing");
    expect(memoryState({ ...EMPTY_OVERVIEW, waiting_run_count: 1 }, false, true).label).toBe("Waiting");
  });

  it("reports disabled, pending, failed and up to date in that order", () => {
    expect(memoryState({ ...EMPTY_OVERVIEW, log_count: 3 }, false, true).label).toBe("Disabled");
    expect(memoryState({ ...EMPTY_OVERVIEW, log_count: 3, failed_run_count: 1 }, true, true).label).toBe("3 pending");
    expect(memoryState({ ...EMPTY_OVERVIEW, failed_run_count: 1 }, true, true).tone).toBe("error");
    expect(memoryState(EMPTY_OVERVIEW, true, false).description).toContain("Run an organization when you are ready.");
  });
});

describe("organizePhase", () => {
  it("only allows a new run when Memory is on and no run is open", () => {
    expect(organizePhase(config, EMPTY_OVERVIEW, false)).toBe("ready");
    expect(organizePhase(config, EMPTY_OVERVIEW, true)).toBe("disabled");
    expect(organizePhase({ ...config, enabled: false }, EMPTY_OVERVIEW, false)).toBe("disabled");
    expect(organizePhase(config, { ...EMPTY_OVERVIEW, active_run_count: 1, waiting_run_count: 1 }, false)).toBe("waiting");
    expect(organizePhase(config, { ...EMPTY_OVERVIEW, active_run_count: 1 }, false)).toBe("stopping");
    expect(organizePhase(config, EMPTY_OVERVIEW, false, true)).toBe("blocked");
  });
});

describe("helpers", () => {
  it("counts each tag key once per memory, most common first", () => {
    const tag = (key: string) => ({ key, value: "x" });
    expect(tagCategories([{ tags: [tag("b"), tag("b")] }, { tags: [tag("a"), tag("b")] }, { tags: [tag("a")] }, { tags: [tag("c")] }]))
      .toEqual([["a", 2], ["b", 2], ["c", 1]]);
  });

  it("toggles one event trigger without duplicating it", () => {
    expect(withEventTrigger(["task.finished", "x"], "task.finished", true)).toEqual(["x", "task.finished"]);
    expect(withEventTrigger(["task.finished", "x"], "task.finished", false)).toEqual(["x"]);
  });

  it("treats trigger order and config option order as the same config", () => {
    const draft = configToDraft(config);
    expect(sameMemoryConfig(draft, { ...draft, event_triggers: [...draft.event_triggers].reverse() })).toBe(true);
    const a = { ...draft, agent_config: { source: "config_options" as const, agent_id: "c", values: { a: "1", b: "2" } } };
    const b = { ...draft, agent_config: { source: "config_options" as const, agent_id: "c", values: { b: "2", a: "1" } } };
    expect(sameMemoryConfig(a, b)).toBe(true);
    expect(sameMemoryConfig(draft, { ...draft, pending_log_threshold: null })).toBe(false);
  });

  it("sums a run's memory changes from its result", () => {
    expect(runChanges(undefined)).toBeNull();
    expect(runChanges({ entities_created: 2, entities_updated: "1", relations_changed: 4 })).toEqual({ memories: 3, relations: 4 });
  });
});
