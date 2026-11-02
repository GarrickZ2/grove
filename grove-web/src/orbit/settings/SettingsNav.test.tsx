import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsNav } from "./SettingsNav";
import { SETTINGS_PAGES, searchSettingsPages, type SettingsPageId } from "./settingsModel";

describe("SettingsNav", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn();
  const onJump = vi.fn();
  const onCursorChange = vi.fn();
  const onQueryChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  function render({ query = "", cursor = 0, activePage = "agents" as SettingsPageId, attention = new Set<SettingsPageId>(), showSubs = true } = {}) {
    act(() => root.render(
      <SettingsNav
        pages={SETTINGS_PAGES}
        hits={searchSettingsPages(SETTINGS_PAGES, query)}
        activePage={activePage}
        activeSub="default"
        attention={attention}
        query={query}
        onQueryChange={onQueryChange}
        cursor={cursor}
        onCursorChange={onCursorChange}
        onSelect={onSelect}
        onJump={onJump}
        searchRef={createRef<HTMLInputElement>()}
        showSubs={showSubs}
      />,
    ));
  }
  const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
  const press = (key: string) => act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  const navLabels = () => [...container.querySelectorAll(".ost-nitem-label")].map((node) => node.textContent);

  it("lists every page, agents first, with separators between groups", () => {
    render({ activePage: "agents" });
    expect(navLabels()).toEqual([
      "Agents",
      "General", "Appearance", "Notifications", "Keyboard Shortcuts",
      "Terminal", "Worktrees",
      "Voice input", "Voice control", "Agent voice", "AI providers",
      "System",
    ]);
    const separatorsAfter = [...container.querySelectorAll(".ost-sep")].map((sep) =>
      sep.previousElementSibling?.classList.contains("ost-subs")
        ? sep.previousElementSibling.previousElementSibling?.textContent
        : sep.previousElementSibling?.textContent);
    expect(separatorsAfter).toEqual(["Agents", "Keyboard Shortcuts", "Worktrees", "AI providers"]);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("Agents");
  });

  it("filters to matching pages and shows an empty state", () => {
    render({ query: "zellij" });
    expect(navLabels()).toEqual(["Terminal"]);
    render({ query: "no such setting" });
    expect(navLabels()).toEqual([]);
    expect(container.textContent).toContain("No settings match");
  });

  it("moves the cursor through hits and opens the highlighted sub-section on Enter", () => {
    render({ query: "indexing" });
    press("ArrowDown");
    expect(onCursorChange).toHaveBeenCalledWith(0);
    press("Enter");
    expect(onSelect).toHaveBeenCalledWith("worktrees", "indexing");
  });

  it("walks pages directly with the arrows when there is no query", () => {
    render({ activePage: "general" });
    press("ArrowDown");
    expect(onSelect).toHaveBeenLastCalledWith("appearance");
    press("ArrowUp");
    expect(onSelect).toHaveBeenLastCalledWith("agents");
  });

  it("wraps from the first page to the last", () => {
    render({ activePage: "agents" });
    press("ArrowUp");
    expect(onSelect).toHaveBeenLastCalledWith("system");
  });

  it("expands only the active page's sub-sections and jumps on click", () => {
    render({ activePage: "worktrees" });
    const open = container.querySelectorAll(".ost-subs.is-open .ost-sub");
    expect([...open].map((node) => node.textContent)).toEqual(["AutoLink", "Code Indexing"]);
    act(() => (open[1] as HTMLButtonElement).click());
    expect(onJump).toHaveBeenCalledWith("indexing");
  });

  it("keeps sub-sections collapsed when the page fits without scrolling", () => {
    render({ activePage: "worktrees", showSubs: false });
    expect(container.querySelectorAll(".ost-subs.is-open")).toHaveLength(0);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("Worktrees");
  });

  it("still opens a matched sub-section from search when sub-sections are hidden", () => {
    render({ query: "indexing", showSubs: false });
    press("Enter");
    expect(onSelect).toHaveBeenCalledWith("worktrees", "indexing");
  });

  it("marks pages that need attention", () => {
    render({ attention: new Set<SettingsPageId>(["terminal"]) });
    const terminal = container.querySelector("#ost-nav-terminal");
    expect(terminal?.querySelector('[aria-label="Needs setup"]')).not.toBeNull();
    expect(container.querySelectorAll('[aria-label="Needs setup"]')).toHaveLength(1);
  });
});
