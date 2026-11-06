import { beforeEach, describe, expect, it } from "vitest";
import type { SessionConfigOption } from "../../api/tasks";
import { promptConfigFromSelection, readSavedSelection, saveSelection } from "./orbitDraftConfig";

const option = (id: string, currentValue: string | boolean) => ({ id, currentValue }) as SessionConfigOption;

describe("promptConfigFromSelection", () => {
  it("sends a value that is shown but was never touched", () => {
    const selection = { source: "config_options" as const, agent_id: "claude-acp", values: {} };
    expect(promptConfigFromSelection(selection, [option("mode", "bypassPermissions")])).toEqual({ config_options: { mode: "bypassPermissions" } });
  });

  it("lets a choice made on the page win over the Agent's last state", () => {
    const selection = { source: "config_options" as const, agent_id: "claude-acp", values: { mode: "plan" } };
    expect(promptConfigFromSelection(selection, [option("mode", "auto"), option("fast", false)])).toEqual({ config_options: { mode: "plan", fast: false } });
  });

  it("sends nothing when there is nothing to configure", () => {
    expect(promptConfigFromSelection({ source: "config_options", agent_id: "a", values: {} })).toBeUndefined();
    expect(promptConfigFromSelection({ source: "default", agent_id: "a" })).toBeUndefined();
  });
});

describe("saved selections", () => {
  beforeEach(() => localStorage.clear());

  it("keeps each Agent's choice separately", () => {
    saveSelection({ source: "config_options", agent_id: "claude-acp", values: { mode: "plan" } });
    saveSelection({ source: "modes", agent_id: "codex-acp", mode_id: "auto" });
    expect(readSavedSelection("claude-acp")).toEqual({ source: "config_options", agent_id: "claude-acp", values: { mode: "plan" } });
    expect(readSavedSelection("codex-acp")).toEqual({ source: "modes", agent_id: "codex-acp", mode_id: "auto" });
    expect(readSavedSelection("other")).toBeUndefined();
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("grove-orbit-new-config", "not json");
    expect(readSavedSelection("claude-acp")).toBeUndefined();
  });
});
