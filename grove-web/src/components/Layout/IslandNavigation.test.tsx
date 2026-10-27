import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IslandNavigation } from "./IslandNavigation";
import { fitIslandPages } from "./islandLayout";

const pages = Array.from({ length: 16 }, (_, index) => ({
  id: `page-${index}`, label: `Page ${index}`, icon: <span />,
}));

describe("Island navigation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let width: number;
  let resize: () => void;
  const onSelect = vi.fn();
  const render = () => root.render(<IslandNavigation pages={pages} activeId="page-15" onSelect={onSelect} />);

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    width = 196;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onSelect.mockClear();
    act(render);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fits every button, reserving overflow space and keeping the active plugin visible", () => {
    for (const available of [36, 76, 116, 196, 316, 636, 800]) {
      const { visible, overflow } = fitIslandPages(pages, available, "page-15");
      const buttons = visible.length + Number(overflow.length > 0);
      expect(buttons * 40 - 4).toBeLessThanOrEqual(available);
      expect([...visible, ...overflow].map((page) => page.id).sort()).toEqual(pages.map((page) => page.id).sort());
      if (visible.length) expect(visible.some((page) => page.id === "page-15")).toBe(true);
    }
  });

  it("opens overflow with focus, handles Escape and selects a hidden page", () => {
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="More pages"]')!;
    act(() => trigger.click());
    const popup = host.querySelector('[role="dialog"]')!;
    const first = popup.querySelector<HTMLButtonElement>("button")!;
    expect(document.activeElement).toBe(first);
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    act(() => host.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click());
    expect(onSelect).toHaveBeenCalledWith("page-3");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("moves pages back into the toolbar when resized wider", () => {
    expect(host.querySelector('button[aria-label="Page 14"]')).toBeNull();
    act(() => { width = 800; resize(); });
    expect(host.querySelector('button[aria-label="More pages"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Page 14"]')).not.toBeNull();
    act(() => { width = 76; resize(); });
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(host.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("Page 15");
  });
});
