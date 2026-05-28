import { describe, it, expect } from "vitest";
import { parseHotkey, matchesHotkey } from "../keyParser";

describe("parseHotkey", () => {
  it("parses a single key", () => {
    expect(parseHotkey("j")).toEqual({
      key: "j", alt: false, ctrl: false, meta: false, shift: false,
    });
  });

  it("parses Meta+f", () => {
    expect(parseHotkey("Meta+f")).toEqual({
      key: "f", alt: false, ctrl: false, meta: true, shift: false,
    });
  });

  it("aliases Cmd to meta", () => {
    expect(parseHotkey("Cmd+k").meta).toBe(true);
  });

  it("parses named keys like Escape and ArrowDown", () => {
    expect(parseHotkey("Escape").key).toBe("Escape");
    expect(parseHotkey("ArrowDown").key).toBe("ArrowDown");
  });

  it("converts Space to ' '", () => {
    expect(parseHotkey("Space").key).toBe(" ");
  });

  it("parses Alt+digit", () => {
    expect(parseHotkey("Alt+1")).toEqual({
      key: "1", alt: true, ctrl: false, meta: false, shift: false,
    });
  });

  it("parses Shift+?", () => {
    expect(parseHotkey("Shift+?")).toEqual({
      key: "?", alt: false, ctrl: false, meta: false, shift: true,
    });
  });

  it("parses Meta+Shift+[", () => {
    expect(parseHotkey("Meta+Shift+[")).toEqual({
      key: "[", alt: false, ctrl: false, meta: true, shift: true,
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

  it("is case-insensitive for single letters", () => {
    expect(matchesHotkey(ev("J"), parseHotkey("j"))).toBe(true);
  });

  it("requires matching modifiers", () => {
    expect(matchesHotkey(ev("f", { meta: true }), parseHotkey("Meta+f"))).toBe(true);
    expect(matchesHotkey(ev("f"), parseHotkey("Meta+f"))).toBe(false);
  });

  it("rejects extra modifiers", () => {
    expect(matchesHotkey(ev("f", { meta: true, alt: true }), parseHotkey("Meta+f"))).toBe(false);
  });

  it("matches named keys", () => {
    expect(matchesHotkey(ev("Escape"), parseHotkey("Escape"))).toBe(true);
    expect(matchesHotkey(ev("ArrowDown"), parseHotkey("ArrowDown"))).toBe(true);
  });

  it("uses e.code for Alt+digit (macOS Alt remaps e.key)", () => {
    // macOS Alt+1 produces key="¡" but code="Digit1"
    expect(matchesHotkey(ev("¡", { alt: true, code: "Digit1" }), parseHotkey("Alt+1"))).toBe(true);
    expect(matchesHotkey(ev("™", { alt: true, code: "Digit2" }), parseHotkey("Alt+1"))).toBe(false);
  });

  it("Shift only enforced when explicit", () => {
    // Bare "?" matches even when shift is pressed (since "?" on US keyboard needs shift)
    expect(matchesHotkey(ev("?", { shift: true }), parseHotkey("?"))).toBe(true);
    // Explicit Shift+? requires shift
    expect(matchesHotkey(ev("?", { shift: false }), parseHotkey("Shift+?"))).toBe(false);
    expect(matchesHotkey(ev("?", { shift: true }), parseHotkey("Shift+?"))).toBe(true);
  });
});
