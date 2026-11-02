import { describe, expect, it } from "vitest";
import {
  SCROLL_SPY_THRESHOLD,
  SETTINGS_PAGES,
  moveCursor,
  pickActiveSection,
  searchSettingsPages,
} from "./settingsModel";

describe("searchSettingsPages", () => {
  it("returns every page for an empty query", () => {
    expect(searchSettingsPages(SETTINGS_PAGES, "  ").map((hit) => hit.pageId)).toEqual(SETTINGS_PAGES.map((page) => page.id));
  });

  it("matches titles case-insensitively without a sub-section", () => {
    expect(searchSettingsPages(SETTINGS_PAGES, "APPEARANCE")).toEqual([{ pageId: "appearance" }]);
  });

  it("points at the sub-section whose label matched", () => {
    expect(searchSettingsPages(SETTINGS_PAGES, "code indexing")).toEqual([{ pageId: "worktrees", subId: "indexing" }]);
    expect(searchSettingsPages(SETTINGS_PAGES, "render window")).toEqual([{ pageId: "agents", subId: "render" }]);
  });

  it("matches keywords and requires every term", () => {
    expect(searchSettingsPages(SETTINGS_PAGES, "zellij").map((hit) => hit.pageId)).toEqual(["terminal"]);
    expect(searchSettingsPages(SETTINGS_PAGES, "zellij theme")).toEqual([]);
  });
});

describe("moveCursor", () => {
  it("wraps in both directions", () => {
    expect(moveCursor(0, 1, 3)).toBe(1);
    expect(moveCursor(2, 1, 3)).toBe(0);
    expect(moveCursor(0, -1, 3)).toBe(2);
    expect(moveCursor(-1, 1, 3)).toBe(0);
  });

  it("stays at 0 for an empty list", () => {
    expect(moveCursor(4, 1, 0)).toBe(0);
  });
});

describe("pickActiveSection", () => {
  const anchors = [
    { id: "a", top: 0 },
    { id: "b", top: 500 },
    { id: "c", top: 1000 },
  ];

  it("starts on the first section", () => {
    expect(pickActiveSection(anchors, 0, 600, 2000)).toBe("a");
  });

  it("switches once a section crosses the threshold line", () => {
    expect(pickActiveSection(anchors, 500 - SCROLL_SPY_THRESHOLD - 1, 600, 2000)).toBe("a");
    expect(pickActiveSection(anchors, 500 - SCROLL_SPY_THRESHOLD, 600, 2000)).toBe("b");
  });

  it("selects the last section at the bottom even if it never crossed", () => {
    expect(pickActiveSection(anchors, 1400, 600, 2000)).toBe("c");
  });

  it("does not treat unscrollable content as scrolled to the bottom", () => {
    expect(pickActiveSection(anchors, 0, 600, 600)).toBe("a");
  });

  it("returns undefined without anchors", () => {
    expect(pickActiveSection([], 0, 600, 600)).toBeUndefined();
  });
});

