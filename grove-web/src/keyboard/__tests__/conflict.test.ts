import { describe, it, expect } from "vitest";
import { detectConflicts, effectiveBindings, effectiveScope } from "../conflict";
import type { CommandDef, KeymapOverride } from "../types";

const cmd = (
  id: string,
  opts: Partial<CommandDef> = {},
): CommandDef => ({
  id,
  name: id,
  category: "test",
  ...opts,
});

describe("detectConflicts", () => {
  it("no conflict when bindings differ", () => {
    expect(
      detectConflicts([
        cmd("a", { defaultBindings: [{ key: "j" }] }),
        cmd("b", { defaultBindings: [{ key: "k" }] }),
      ]),
    ).toEqual([]);
  });

  it("detects same key + same scope conflict", () => {
    const conflicts = detectConflicts([
      cmd("a", { defaultBindings: [{ key: "j" }], scope: "list" }),
      cmd("b", { defaultBindings: [{ key: "j" }], scope: "list" }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].commandIds.sort()).toEqual(["a", "b"]);
    expect(conflicts[0].key).toBe("j");
    expect(conflicts[0].scope).toBe("list");
  });

  it("same key different scope = no conflict", () => {
    expect(
      detectConflicts([
        cmd("a", { defaultBindings: [{ key: "j" }], scope: "list" }),
        cmd("b", { defaultBindings: [{ key: "j" }], scope: "diff" }),
      ]),
    ).toEqual([]);
  });

  it("same key same scope different when = no conflict", () => {
    expect(
      detectConflicts([
        cmd("a", { defaultBindings: [{ key: "j", when: "x" }], scope: "list" }),
        cmd("b", { defaultBindings: [{ key: "j", when: "!x" }], scope: "list" }),
      ]),
    ).toEqual([]);
  });

  it("user disabled commands skipped", () => {
    const disabled = new Set(["a"]);
    expect(
      detectConflicts(
        [
          cmd("a", { defaultBindings: [{ key: "j" }] }),
          cmd("b", { defaultBindings: [{ key: "j" }] }),
        ],
        new Map(),
        disabled,
      ),
    ).toEqual([]);
  });

  it("user override key respected over default", () => {
    const overrides = new Map<string, KeymapOverride[]>([
      ["b", [{ command_id: "b", key: "j" }]],
    ]);
    const conflicts = detectConflicts(
      [
        cmd("a", { defaultBindings: [{ key: "j" }] }),
        cmd("b", { defaultBindings: [{ key: "k" }] }), // default no conflict
      ],
      overrides,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].commandIds.sort()).toEqual(["a", "b"]);
  });

  it("3-way conflict reported once", () => {
    const conflicts = detectConflicts([
      cmd("a", { defaultBindings: [{ key: "j" }] }),
      cmd("b", { defaultBindings: [{ key: "j" }] }),
      cmd("c", { defaultBindings: [{ key: "j" }] }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].commandIds.sort()).toEqual(["a", "b", "c"]);
  });

  // Regression: a global binding shadowed by a scoped one on the same key is
  // the intended scope-stack layering, NOT a conflict. A previous cross-scope
  // rule mis-flagged every nav.* (global) against blitz.* (tasks) on Mod+1..0.
  it("global vs scoped on same key = no conflict (scope stack shadows)", () => {
    expect(
      detectConflicts([
        cmd("nav.dashboard", {
          defaultBindings: [{ key: "Mod+1" }],
          defaultWhen: "!inWorkspace",
        }),
        cmd("blitz.task.jump1", {
          defaultBindings: [{ key: "Mod+1" }],
          scope: "tasks",
          defaultWhen: "inBlitzMode",
        }),
      ]),
    ).toEqual([]);
  });

  // Regression: two global commands on the same key with mutually exclusive
  // when expressions (nav.tasks vs nav.resource on Mod+3) are context-
  // disambiguated — not a conflict.
  it("global same key, distinct when = no conflict", () => {
    expect(
      detectConflicts([
        cmd("nav.tasks", {
          defaultBindings: [{ key: "Mod+3" }],
          defaultWhen: "!inWorkspace && !studioProject",
        }),
        cmd("nav.resource", {
          defaultBindings: [{ key: "Mod+3" }],
          defaultWhen: "!inWorkspace && studioProject",
        }),
      ]),
    ).toEqual([]);
  });

  // …but two global commands on the same key with no when still conflict.
  it("global same key, both unconditional = conflict", () => {
    const conflicts = detectConflicts([
      cmd("x", { defaultBindings: [{ key: "Mod+7" }] }),
      cmd("y", { defaultBindings: [{ key: "Mod+7" }] }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].commandIds.sort()).toEqual(["x", "y"]);
  });
});

describe("effectiveBindings", () => {
  it("default bindings when no override", () => {
    const def = cmd("a", { defaultBindings: [{ key: "j" }, { key: "ArrowDown" }] });
    expect(effectiveBindings(def)).toEqual([{ key: "j" }, { key: "ArrowDown" }]);
  });

  it("override replaces all defaults", () => {
    const def = cmd("a", { defaultBindings: [{ key: "j" }, { key: "ArrowDown" }] });
    const result = effectiveBindings(def, [{ command_id: "a", key: "n" }]);
    expect(result).toEqual([{ key: "n", when: undefined }]);
  });

  it("multiple override bindings all apply", () => {
    const def = cmd("a", { defaultBindings: [{ key: "j" }] });
    const result = effectiveBindings(def, [
      { command_id: "a", key: "n" },
      { command_id: "a", key: "Mod+n", when_ctx: "x" },
    ]);
    expect(result).toEqual([
      { key: "n", when: undefined },
      { key: "Mod+n", when: "x" },
    ]);
  });

  it("empty-key override row = unbind ([])", () => {
    const def = cmd("a", { defaultBindings: [{ key: "j" }] });
    expect(effectiveBindings(def, [{ command_id: "a", key: "" }])).toEqual([]);
  });

  it("override carries when_ctx", () => {
    const def = cmd("a", { defaultBindings: [{ key: "j" }] });
    const result = effectiveBindings(def, [
      {
        command_id: "a",
        key: "n",
        when_ctx: "taskList",
      },
    ]);
    expect(result).toEqual([{ key: "n", when: "taskList" }]);
  });

  it("empty defaults + no override = []", () => {
    expect(effectiveBindings(cmd("a"))).toEqual([]);
  });
});

describe("effectiveScope", () => {
  it("default scope when no override", () => {
    expect(effectiveScope(cmd("a", { scope: "list" }))).toBe("list");
  });
  it("override scope wins", () => {
    expect(
      effectiveScope(cmd("a", { scope: "list" }), [
        {
          command_id: "a",
          key: "j",
          scope: "diff",
        },
      ]),
    ).toBe("diff");
  });
  it("override empty scope = use default", () => {
    expect(
      effectiveScope(cmd("a", { scope: "list" }), [
        {
          command_id: "a",
          key: "j",
          scope: "",
        },
      ]),
    ).toBe("list");
  });
});
