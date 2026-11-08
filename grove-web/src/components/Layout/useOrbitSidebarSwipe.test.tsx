import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOrbitSidebarSwipe } from "./useOrbitSidebarSwipe";

let host: HTMLDivElement;
let root: Root;
const change = vi.fn();

function Harness({ collapsed }: { collapsed: boolean }) {
  useOrbitSidebarSwipe({ enabled: true, collapsed, onCollapsedChange: change });
  return (
    <>
      <aside data-grove-sidebar><p>Sidebar</p></aside>
      <main><p>Page</p><div role="separator" /><textarea /></main>
    </>
  );
}

function touch(target: Element, type: string, x: number, y = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: [{ clientX: x, clientY: y }] });
  act(() => { target.dispatchEvent(event); });
}
function swipe(target: Element, toX: number, toY = 0) {
  touch(target, "touchstart", 100);
  touch(target, "touchmove", 100 + (toX - 100) / 2, toY / 2);
  touch(target, "touchmove", toX, toY);
  touch(target, "touchend", toX, toY);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("opens a collapsed sidebar with a rightward swipe on the page", () => {
  act(() => root.render(<Harness collapsed />));
  swipe(host.querySelector("main p")!, 200);
  expect(change).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledWith(false);
});

it("collapses from a leftward swipe on the sidebar, not on the page", () => {
  act(() => root.render(<Harness collapsed={false} />));
  swipe(host.querySelector("main p")!, 0);
  expect(change).not.toHaveBeenCalled();
  swipe(host.querySelector("aside p")!, 0);
  expect(change).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledWith(true);
});

it("leaves scrolling, short drags, resize grips and text fields alone", () => {
  act(() => root.render(<Harness collapsed />));
  swipe(host.querySelector("main p")!, 110, 200);
  swipe(host.querySelector("main p")!, 130);
  swipe(host.querySelector('[role="separator"]')!, 200);
  swipe(host.querySelector("textarea")!, 200);
  expect(change).not.toHaveBeenCalled();
});
