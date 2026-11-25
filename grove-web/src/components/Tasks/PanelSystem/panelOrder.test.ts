import { describe, expect, it } from "vitest";
import { MORE, fullPanelOrder, groupPanels, movePanel, orderPanels, splitPanels } from "./panelOrder";

const of = (keys: string[]) => keys.map((key) => ({ key }));
const keys = (panels: { key: string }[]) => panels.map((p) => p.key);
const STUDIO = ["terminal", "review", "editor", "browser", "graph", "artifacts", "sketch", "design", "stats", "notes"];
const CODING = ["terminal", "review", "editor", "browser", "graph", "stats", "git", "notes", "comments"];

describe("panel order", () => {
  it("puts what each kind of task makes first, plugins last", () => {
    expect(keys(orderPanels(of(["plugin:a", ...STUDIO]), null, true))).toEqual(["design", "sketch", "artifacts", "browser", "review", "editor", "terminal", "notes", "graph", "stats", "plugin:a"]);
    expect(keys(orderPanels(of(CODING), undefined, false))).toEqual(["review", "editor", "terminal", "browser", "git", "comments", "notes", "graph", "stats"]);
  });

  it("follows the user's order and slots in panels it doesn't know", () => {
    expect(keys(orderPanels(of(["review", "editor", "terminal", "plugin:b", "plugin:a"]), ["terminal", "plugin:a", "review"], false)))
      .toEqual(["terminal", "plugin:a", "review", "editor", "plugin:b"]);
  });

  it("keeps the place of a panel that isn't available now", () => {
    expect(fullPanelOrder(["review", "editor"], ["plugin:off", "editor", "review", MORE], false)).toEqual(["plugin:off", "editor", "review", MORE]);
  });

  it("puts a few panels on the toolbar and the rest under More", () => {
    const coding = splitPanels(of([...CODING, "plugin:a"]), null, false);
    expect(keys(coding.shown)).toEqual(["review", "editor", "terminal"]);
    expect(keys(coding.more)).toEqual(["browser", "git", "comments", "notes", "graph", "stats", "plugin:a"]);
    const studio = splitPanels(of(STUDIO), null, true);
    expect(keys(studio.shown)).toEqual(["design", "sketch", "artifacts"]);
    expect(keys(studio.more)).toEqual(["browser", "review", "editor", "terminal", "notes", "graph", "stats"]);
  });

  it("shows what the user put on the toolbar, however many", () => {
    const one = splitPanels(of(["review", "editor", "git"]), ["git", MORE, "review", "editor"], false);
    expect(keys(one.shown)).toEqual(["git"]);
    expect(keys(one.more)).toEqual(["review", "editor"]);
    expect(keys(splitPanels(of(["review", "editor"]), ["review", "editor", MORE], false).more)).toEqual([]);
  });

  it("starts a new panel on the side it has by default", () => {
    const { shown, more } = splitPanels(of(["git", "comments", "review"]), ["git", MORE], false);
    expect(keys(shown)).toEqual(["review", "git"]);
    expect(keys(more)).toEqual(["comments"]);
  });

  it("divides whole groups only", () => {
    expect(groupPanels(of(["design", "sketch", "browser", "terminal", "notes", "plugin:a"]), true).map(keys))
      .toEqual([["design", "sketch"], ["browser", "terminal"], ["notes"], ["plugin:a"]]);
    expect(groupPanels(of(["design", "terminal", "sketch"]), true).map(keys)).toEqual([["design", "terminal", "sketch"]]);
  });

  it("moves a panel beside another", () => {
    expect(movePanel(["a", "b", "c"], { key: "c", target: "a", side: "before" })).toEqual(["c", "a", "b"]);
    expect(movePanel(["a", "b", "c"], { key: "a", target: "b", side: "after" })).toEqual(["b", "a", "c"]);
    expect(movePanel(["a", "b"], { key: "a", target: "gone", side: "after" })).toEqual(["a", "b"]);
  });
});
