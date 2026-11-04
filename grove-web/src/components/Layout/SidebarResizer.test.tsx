import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SidebarResizer } from "./SidebarResizer";

let root: Root;
let host: HTMLDivElement;
const handle = () => host.querySelector<HTMLButtonElement>(".sidebar-resizer")!;
const width = () => document.documentElement.style.getPropertyValue("--orbit-sidebar-width");
const pointer = (type: string, clientX: number) => act(() => {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  handle().dispatchEvent(event);
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 1600);
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<SidebarResizer />));
  handle().setPointerCapture = vi.fn();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("follows the drag, stays in range, and remembers where it stopped", () => {
  pointer("pointerdown", 256);
  pointer("pointermove", 300);
  expect(width()).toBe("300px");
  expect(localStorage.getItem("grove:sidebar-width")).toBeNull();
  pointer("pointermove", 2000);
  expect(width()).toBe(`${SIDEBAR_MAX_WIDTH}px`);
  pointer("pointermove", 0);
  expect(width()).toBe(`${SIDEBAR_MIN_WIDTH}px`);
  pointer("pointermove", 300);
  pointer("pointerup", 300);
  expect(localStorage.getItem("grove:sidebar-width")).toBe("300");
  expect(document.documentElement.classList.contains("is-resizing-sidebar")).toBe(false);
});

it("leaves room for the content in a narrow window", () => {
  vi.stubGlobal("innerWidth", 900);
  pointer("pointerdown", 256);
  pointer("pointermove", 2000);
  expect(width()).toBe("300px");
  pointer("pointerup", 2000);
});

it("resets on double-click and moves with the arrow keys", () => {
  act(() => handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(width()).toBe(`${SIDEBAR_DEFAULT_WIDTH + 20}px`);
  act(() => handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(width()).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
  expect(localStorage.getItem("grove:sidebar-width")).toBe(String(SIDEBAR_DEFAULT_WIDTH));
});
