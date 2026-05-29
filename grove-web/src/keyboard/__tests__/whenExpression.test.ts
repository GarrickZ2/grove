import { describe, it, expect } from "vitest";
import {
  parseWhen,
  validateWhen,
  extractContextKeys,
  WhenParseError,
} from "../whenExpression";

describe("parseWhen", () => {
  it("empty / whitespace = always true", () => {
    expect(parseWhen("")({})).toBe(true);
    expect(parseWhen(undefined)({})).toBe(true);
    expect(parseWhen("   ")({})).toBe(true);
  });

  it("simple identifier", () => {
    const f = parseWhen("foo");
    expect(f({ foo: true })).toBe(true);
    expect(f({ foo: false })).toBe(false);
    expect(f({})).toBe(false);
  });

  it("negation", () => {
    const f = parseWhen("!foo");
    expect(f({ foo: true })).toBe(false);
    expect(f({ foo: false })).toBe(true);
    expect(f({})).toBe(true);
  });

  it("and", () => {
    const f = parseWhen("a && b");
    expect(f({ a: true, b: true })).toBe(true);
    expect(f({ a: true, b: false })).toBe(false);
    expect(f({ a: false, b: true })).toBe(false);
  });

  it("or", () => {
    const f = parseWhen("a || b");
    expect(f({ a: true, b: false })).toBe(true);
    expect(f({ a: false, b: true })).toBe(true);
    expect(f({ a: false, b: false })).toBe(false);
  });

  it("precedence: ! binds tightest, && over ||", () => {
    const f = parseWhen("a && !b || c");
    // (a && (!b)) || c
    expect(f({ a: true, b: false, c: false })).toBe(true);
    expect(f({ a: true, b: true, c: false })).toBe(false);
    expect(f({ a: false, b: false, c: true })).toBe(true);
  });

  it("parens override precedence", () => {
    const f = parseWhen("a && (b || c)");
    expect(f({ a: true, b: true, c: false })).toBe(true);
    expect(f({ a: true, b: false, c: true })).toBe(true);
    expect(f({ a: true, b: false, c: false })).toBe(false);
    expect(f({ a: false, b: true, c: true })).toBe(false);
  });

  it("dotted identifier", () => {
    const f = parseWhen("filePreview.fullscreen");
    expect(f({ "filePreview.fullscreen": true })).toBe(true);
    expect(f({ "filePreview.fullscreen": false })).toBe(false);
  });

  it("nested negation", () => {
    const f = parseWhen("!!foo");
    expect(f({ foo: true })).toBe(true);
    expect(f({ foo: false })).toBe(false);
  });

  it("nested parens", () => {
    const f = parseWhen("((a))");
    expect(f({ a: true })).toBe(true);
  });

  it("complex realistic expression", () => {
    const f = parseWhen("workspace && canOperate && !(dialogOpen || helpOverlayOpen)");
    expect(f({ workspace: true, canOperate: true })).toBe(true);
    expect(f({ workspace: true, canOperate: true, dialogOpen: true })).toBe(false);
    expect(f({ workspace: true, canOperate: false })).toBe(false);
  });
});

describe("parseWhen errors", () => {
  it("missing close paren", () => {
    expect(() => parseWhen("(a && b")).toThrow(WhenParseError);
  });

  it("missing open paren", () => {
    expect(() => parseWhen("a)")).toThrow(WhenParseError);
  });

  it("unexpected operator", () => {
    expect(() => parseWhen("&& a")).toThrow(WhenParseError);
  });

  it("invalid char", () => {
    expect(() => parseWhen("a $ b")).toThrow(WhenParseError);
  });

  it("extra tokens", () => {
    expect(() => parseWhen("a b")).toThrow(WhenParseError);
  });
});

describe("validateWhen", () => {
  it("returns null for valid", () => {
    expect(validateWhen("")).toBeNull();
    expect(validateWhen("a && b")).toBeNull();
  });
  it("returns error message for invalid", () => {
    expect(validateWhen("(a")).toMatch(/expected/);
  });
});

describe("extractContextKeys", () => {
  it("empty for empty expression", () => {
    expect(extractContextKeys("")).toEqual([]);
  });
  it("extracts unique identifiers", () => {
    expect(extractContextKeys("a && b || !a").sort()).toEqual(["a", "b"]);
  });
  it("includes dotted keys", () => {
    expect(extractContextKeys("preview.fullscreen && !preview.modal").sort()).toEqual([
      "preview.fullscreen",
      "preview.modal",
    ]);
  });
});
