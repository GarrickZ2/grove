import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBuddyBackSwipe } from "./useBuddyBackSwipe";
let host: HTMLDivElement; let root: Root;
const back = vi.fn();
function Harness({ enabled = true }: { enabled?: boolean }) {
  const pageRef = useRef<HTMLElement>(null);
  useBuddyBackSwipe({ enabled, pageRef, onBack: back });
  return <main ref={pageRef}><p>Conversation</p><textarea /><div className="horizontal">Long code block</div></main>;
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("innerWidth", 390); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<Harness />)); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function touch(target: Element, type: string, x: number, y = 0, count = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) });
  act(() => target.dispatchEvent(event)); return event;
}
it("returns to the list after a rightward swipe and cleans up the transform", () => {
  const page = host.querySelector("main")!;
  touch(page, "touchstart", 10); expect(touch(page, "touchmove", 200).defaultPrevented).toBe(true);
  expect(page.style.transform).toContain("190px"); touch(page, "touchend", 200);
  expect(back).toHaveBeenCalledOnce(); expect(page.style.transform).toBe("");
});
it("leaves vertical scrolling, editable fields and horizontal scrollers alone", () => {
  const page = host.querySelector("main")!;
  touch(page, "touchstart", 10); expect(touch(page, "touchmove", 30, 200).defaultPrevented).toBe(false); touch(page, "touchend", 30);
  const input = host.querySelector("textarea")!;
  touch(input, "touchstart", 10); touch(input, "touchmove", 250); touch(input, "touchend", 250);
  const scroller = host.querySelector<HTMLElement>(".horizontal")!;
  Object.defineProperties(scroller, { scrollWidth: { value: 800 }, clientWidth: { value: 200 }, scrollLeft: { value: 80 } }); scroller.style.overflowX = "auto";
  touch(scroller, "touchstart", 10); touch(scroller, "touchmove", 250); touch(scroller, "touchend", 250);
  expect(back).not.toHaveBeenCalled();
});
it("does not navigate on cancellation, multi-touch or while disabled", () => {
  const page = host.querySelector("main")!;
  touch(page, "touchstart", 10); touch(page, "touchmove", 250); touch(page, "touchcancel", 250);
  expect(page.style.transform).toBe("");
  touch(page, "touchstart", 10); touch(page, "touchmove", 250, 0, 2); touch(page, "touchend", 250);
  act(() => root.render(<Harness enabled={false} />));
  touch(page, "touchstart", 10); touch(page, "touchmove", 250); touch(page, "touchend", 250);
  expect(back).not.toHaveBeenCalled();
});
