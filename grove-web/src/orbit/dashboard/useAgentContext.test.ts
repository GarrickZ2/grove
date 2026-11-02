import { describe, expect, it } from "vitest";
import { buildContextSources } from "./useAgentContext";

const none = { instructionLines: null, memoryEnabled: null, memoryEntities: null, memoryOrganizedAt: null, skillCount: null };

describe("buildContextSources", () => {
  it("leaves out sources whose facts did not load", () => {
    expect(buildContextSources({ projectType: "repo" }, none)).toEqual([]);
  });

  it("shows counts, never estimates, and marks disabled sources off", () => {
    const sources = buildContextSources({ projectType: "studio" }, { ...none, instructionLines: 12, memoryEnabled: false, skillCount: 3 });
    expect(sources.map((source) => [source.id, source.on, source.label])).toEqual([
      ["instructions", true, "12 lines"],
      ["memory", false, null],
      ["skills", true, "3 skills"],
    ]);
  });

  it("only offers instructions on Studio projects and labels memory entries", () => {
    const sources = buildContextSources({ projectType: "repo" }, { ...none, instructionLines: 4, memoryEnabled: true, memoryEntities: 1, skillCount: 0 });
    expect(sources.map((source) => [source.id, source.label, source.detail])).toEqual([
      ["memory", "1 entry", "Not organized yet"],
      ["skills", null, "None installed"],
    ]);
  });
});
