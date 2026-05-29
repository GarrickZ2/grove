import { describe, it, expect } from "vitest";
import { parseHotkey, matchesHotkey, formatKeyboardEvent } from "../keyParser";

describe("parseHotkey", () => {
  it("parses a single key", () => {
    expect(parseHotkey("j")).toEqual({
      key: "j", alt: false, ctrl: false, meta: false, shift: false, mod: false,
    });
  });

  it("parses Meta+f", () => {
    expect(parseHotkey("Meta+f")).toEqual({
      key: "f", alt: false, ctrl: false, meta: "any", shift: false, mod: false,
    });
  });

  it("aliases Cmd to meta", () => {
    expect(parseHotkey("Cmd+k").meta).toBe("any");
  });

  it("parses left/right modifier prefixes", () => {
    expect(parseHotkey("LeftMeta+k").meta).toBe("left");
    expect(parseHotkey("RightMeta+k").meta).toBe("right");
    expect(parseHotkey("LeftAlt+a").alt).toBe("left");
    expect(parseHotkey("RightCtrl+a").ctrl).toBe("right");
    // Mod has no side concept — only mod:true is set.
    expect(parseHotkey("Mod+k").mod).toBe(true);
  });

  it("parses Mod token (cross-platform)", () => {
    expect(parseHotkey("Mod+f")).toEqual({
      key: "f", alt: false, ctrl: false, meta: false, shift: false, mod: true,
    });
  });

  it("Mod combined with Shift", () => {
    expect(parseHotkey("Mod+Shift+P")).toEqual({
      key: "P", alt: false, ctrl: false, meta: false, shift: "any", mod: true,
    });
  });

  it("parses named keys", () => {
    expect(parseHotkey("Escape").key).toBe("Escape");
    expect(parseHotkey("ArrowDown").key).toBe("ArrowDown");
  });

  it("converts Space to ' '", () => {
    expect(parseHotkey("Space").key).toBe(" ");
  });

  it("parses Alt+digit", () => {
    expect(parseHotkey("Alt+1")).toEqual({
      key: "1", alt: "any", ctrl: false, meta: false, shift: false, mod: false,
    });
  });

  it("parses Shift+?", () => {
    expect(parseHotkey("Shift+?")).toEqual({
      key: "?", alt: false, ctrl: false, meta: false, shift: "any", mod: false,
    });
  });
});

describe("matchesHotkey", () => {
  function ev(
    key: string,
    opts: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; code?: string } = {},
  ): KeyboardEvent {
    return new KeyboardEvent("keydown", {
      key,
      code: opts.code,
      altKey: opts.alt ?? false,
      ctrlKey: opts.ctrl ?? false,
      metaKey: opts.meta ?? false,
      shiftKey: opts.shift ?? false,
    });
  }

  it("matches a simple key", () => {
    expect(matchesHotkey(ev("j"), parseHotkey("j"))).toBe(true);
    expect(matchesHotkey(ev("k"), parseHotkey("j"))).toBe(false);
  });

  it("case-insensitive for single letters", () => {
    expect(matchesHotkey(ev("J"), parseHotkey("j"))).toBe(true);
  });

  it("requires matching modifiers", () => {
    expect(matchesHotkey(ev("f", { meta: true }), parseHotkey("Meta+f"))).toBe(true);
    expect(matchesHotkey(ev("f"), parseHotkey("Meta+f"))).toBe(false);
  });

  it("rejects extra modifiers", () => {
    expect(matchesHotkey(ev("f", { meta: true, alt: true }), parseHotkey("Meta+f"))).toBe(false);
  });

  it("Mod matches meta (mac)", () => {
    expect(matchesHotkey(ev("f", { meta: true }), parseHotkey("Mod+f"))).toBe(true);
  });

  it("Mod matches ctrl (linux/win)", () => {
    expect(matchesHotkey(ev("f", { ctrl: true }), parseHotkey("Mod+f"))).toBe(true);
  });

  it("Mod rejects neither meta nor ctrl", () => {
    expect(matchesHotkey(ev("f"), parseHotkey("Mod+f"))).toBe(false);
  });

  it("Mod tolerates both meta and ctrl", () => {
    // some keyboards / setups press both
    expect(matchesHotkey(ev("f", { meta: true, ctrl: true }), parseHotkey("Mod+f"))).toBe(true);
  });

  it("matches named keys", () => {
    expect(matchesHotkey(ev("Escape"), parseHotkey("Escape"))).toBe(true);
    expect(matchesHotkey(ev("ArrowDown"), parseHotkey("ArrowDown"))).toBe(true);
  });

  it("uses e.code for Alt+digit (macOS Alt remaps e.key)", () => {
    expect(matchesHotkey(ev("¡", { alt: true, code: "Digit1" }), parseHotkey("Alt+1"))).toBe(true);
    expect(matchesHotkey(ev("™", { alt: true, code: "Digit2" }), parseHotkey("Alt+1"))).toBe(false);
  });

  it("uses e.code for Mod+Alt+letter (macOS Opt remaps e.key, Opt+C → ç)", () => {
    // Cmd+Opt+C on macOS: e.key is "ç", but e.code is "KeyC".
    expect(
      matchesHotkey(ev("ç", { meta: true, alt: true, code: "KeyC" }), parseHotkey("Mod+Alt+c")),
    ).toBe(true);
    expect(
      matchesHotkey(ev("ç", { meta: true, alt: true, code: "KeyC" }), parseHotkey("Mod+Alt+t")),
    ).toBe(false);
  });

  it("Shift only enforced when explicit", () => {
    expect(matchesHotkey(ev("?", { shift: true }), parseHotkey("?"))).toBe(true);
    expect(matchesHotkey(ev("?", { shift: false }), parseHotkey("Shift+?"))).toBe(false);
    expect(matchesHotkey(ev("?", { shift: true }), parseHotkey("Shift+?"))).toBe(true);
  });

  it("left/right modifier matching uses the sides argument", () => {
    const leftMeta = parseHotkey("LeftMeta+k");
    const sidesLeft = { meta: "left" as const, alt: null, ctrl: null, shift: null };
    const sidesRight = { meta: "right" as const, alt: null, ctrl: null, shift: null };
    // meta down + side left → matches LeftMeta
    expect(matchesHotkey(ev("k", { meta: true }), leftMeta, sidesLeft)).toBe(true);
    // meta down + side right → does NOT match LeftMeta
    expect(matchesHotkey(ev("k", { meta: true }), leftMeta, sidesRight)).toBe(false);
    // no sides info → a side requirement fails closed
    expect(matchesHotkey(ev("k", { meta: true }), leftMeta)).toBe(false);
    // "any"-side binding still matches regardless of physical side
    expect(matchesHotkey(ev("k", { meta: true }), parseHotkey("Meta+k"), sidesRight)).toBe(true);
  });
});

describe("formatKeyboardEvent", () => {
  function ev(
    key: string,
    opts: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
  ): KeyboardEvent {
    return new KeyboardEvent("keydown", {
      key,
      altKey: opts.alt ?? false,
      ctrlKey: opts.ctrl ?? false,
      metaKey: opts.meta ?? false,
      shiftKey: opts.shift ?? false,
    });
  }

  it("emits Mod for meta or ctrl by default", () => {
    expect(formatKeyboardEvent(ev("f", { meta: true }))).toBe("Mod+f");
    expect(formatKeyboardEvent(ev("f", { ctrl: true }))).toBe("Mod+f");
  });

  it("emits literal modifier when prefer=platform", () => {
    expect(formatKeyboardEvent(ev("f", { meta: true }), { prefer: "platform" })).toBe("Meta+f");
    expect(formatKeyboardEvent(ev("f", { ctrl: true }), { prefer: "platform" })).toBe("Ctrl+f");
  });

  it("Space encoded as 'Space'", () => {
    expect(formatKeyboardEvent(ev(" "))).toBe("Space");
  });

  it("combines all modifiers", () => {
    expect(formatKeyboardEvent(ev("p", { alt: true, meta: true, shift: true }))).toBe("Alt+Mod+Shift+p");
  });

  it("emits named keys verbatim", () => {
    expect(formatKeyboardEvent(ev("Escape"))).toBe("Escape");
    expect(formatKeyboardEvent(ev("ArrowDown"))).toBe("ArrowDown");
  });

  it("emits Left/Right prefix when distinguishSide is set", () => {
    expect(
      formatKeyboardEvent(ev("k", { meta: true }), {
        distinguishSide: true,
        sides: { meta: "right", alt: null, ctrl: null, shift: null },
      }),
    ).toBe("RightMeta+k");
    // Without distinguishSide, falls back to cross-platform Mod (no side).
    expect(
      formatKeyboardEvent(ev("k", { meta: true }), {
        sides: { meta: "right", alt: null, ctrl: null, shift: null },
      }),
    ).toBe("Mod+k");
  });
});
