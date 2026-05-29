import { describe, it, expect } from "vitest";
import { COMMAND_CATALOG } from "../catalog";
import { parseWhen, WhenParseError } from "../whenExpression";
import { parseHotkey } from "../keyParser";
import { detectConflicts } from "../conflict";

describe("Command catalog — integrity", () => {
  it("has a reasonable number of commands", () => {
    // Lower bound: a sanity floor in case someone wipes the catalog by accident.
    // Not an upper bound on growth — adding new commands is expected.
    expect(COMMAND_CATALOG.length).toBeGreaterThan(150);
  });

  it("no duplicate ids", () => {
    const ids = new Set<string>();
    const dups: string[] = [];
    for (const c of COMMAND_CATALOG) {
      if (ids.has(c.id)) dups.push(c.id);
      ids.add(c.id);
    }
    expect(dups, `duplicate ids: ${dups.join(", ")}`).toEqual([]);
  });

  it("all commands have non-empty name + category + id", () => {
    const bad = COMMAND_CATALOG.filter(
      (c) => !c.id || !c.name || !c.category,
    );
    expect(
      bad,
      `missing fields: ${bad.map((c) => c.id || "(no-id)").join(", ")}`,
    ).toEqual([]);
  });

  it("all ids match <camelCase>(.camelCase)+ pattern", () => {
    // Lower-case start, dot-separated camelCase segments. Allows mid-word
    // capitalization within segments (e.g. "diffReview.nextFile").
    const pattern = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
    const bad = COMMAND_CATALOG.filter((c) => !pattern.test(c.id));
    expect(
      bad,
      `id convention violations: ${bad.map((c) => c.id).join(", ")}`,
    ).toEqual([]);
  });

  it("all default bindings parse without error", () => {
    const bad: string[] = [];
    for (const c of COMMAND_CATALOG) {
      for (const b of c.defaultBindings ?? []) {
        try {
          parseHotkey(b.key);
        } catch {
          bad.push(`${c.id}: ${b.key}`);
        }
      }
    }
    expect(bad, `unparseable keys: ${bad.join(", ")}`).toEqual([]);
  });

  it("all default when expressions parse without error", () => {
    const bad: string[] = [];
    for (const c of COMMAND_CATALOG) {
      try {
        parseWhen(c.defaultWhen);
      } catch (e) {
        bad.push(`${c.id}: ${(e as WhenParseError).message}`);
      }
      for (const b of c.defaultBindings ?? []) {
        try {
          parseWhen(b.when);
        } catch (e) {
          bad.push(`${c.id} binding ${b.key}: ${(e as WhenParseError).message}`);
        }
      }
    }
    expect(bad, `when parse errors: ${bad.join(", ")}`).toEqual([]);
  });

  it("reports binding conflicts (informational)", () => {
    // Same key + scope + when across commands is a conflict. We don't
    // require zero conflicts (some are intentional, e.g. mac vs linux
    // alternate bindings). But surface the list so reviewers can audit.
    const conflicts = detectConflicts(COMMAND_CATALOG);
    if (conflicts.length > 0) {
      const summary = conflicts
        .map(
          (c) =>
            `${c.key} in [${c.scope || "global"}]${c.when ? ` when '${c.when}'` : ""}: ${c.commandIds.join(" / ")}`,
        )
        .join("\n  ");
      console.warn(`[catalog] ${conflicts.length} keybinding conflicts:\n  ${summary}`);
    }
    // Hard cap: catalog conflicts should be intentional, not careless.
    // Allow some (cross-platform Mod variants, etc.) but flag if it grows.
    expect(conflicts.length).toBeLessThan(40);
  });

  it("ids in the same category are usually grouped (sanity check)", () => {
    // Soft: 95% of consecutive commands share their predecessor's category
    // prefix. This catches obviously misclassified entries.
    let mismatches = 0;
    for (let i = 1; i < COMMAND_CATALOG.length; i++) {
      const prev = COMMAND_CATALOG[i - 1].id.split(".")[0];
      const cur = COMMAND_CATALOG[i].id.split(".")[0];
      if (prev !== cur) mismatches++;
    }
    // We have ~22 category groups across ~232 commands, so ~22 boundaries are expected.
    expect(mismatches).toBeLessThan(40);
  });
});
