import { useEffect, type RefObject } from "react";

/** Like Orbit's drawer gesture: preserve vertical scrolling, editable fields
 * and horizontal scrollers. A phone conversation returns to the Buddy list. */
export function useBuddyBackSwipe({ enabled, pageRef, onBack }: { enabled: boolean; pageRef: RefObject<HTMLElement | null>; onBack: () => void }) {
  useEffect(() => {
    const page = pageRef.current;
    if (!enabled || !page) return;
    let start: { x: number; y: number; time: number; target: Element } | null = null;
    let distance = 0;
    let dragging = false;
    const reset = () => { start = null; dragging = false; distance = 0; page.style.removeProperty("transform"); };
    const begin = (event: TouchEvent) => {
      reset();
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element) || target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, time: event.timeStamp, target };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1) { reset(); return; }
      const touch = event.touches[0];
      const dx = touch.clientX - start.x; const dy = touch.clientY - start.y;
      if (!dragging) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
        if (dx <= Math.abs(dy) * 1.2) { reset(); return; }
        for (let node: Element | null = start.target; node && page.contains(node); node = node.parentElement) {
          if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 1 && node.scrollLeft > 0 && /auto|scroll/.test(getComputedStyle(node).overflowX)) { reset(); return; }
        }
        dragging = true;
      }
      event.preventDefault(); distance = Math.max(0, dx);
      page.style.transform = `translateX(${Math.min(distance, window.innerWidth)}px)`;
    };
    const end = (event: TouchEvent) => {
      const elapsed = start ? event.timeStamp - start.time : 0;
      const goBack = dragging && (distance > window.innerWidth * 0.35 || (distance > 40 && elapsed > 0 && distance / elapsed > 0.45));
      reset(); if (goBack) onBack();
    };
    page.addEventListener("touchstart", begin, { passive: true });
    page.addEventListener("touchmove", move, { passive: false });
    page.addEventListener("touchend", end);
    page.addEventListener("touchcancel", reset);
    return () => {
      page.removeEventListener("touchstart", begin); page.removeEventListener("touchmove", move);
      page.removeEventListener("touchend", end); page.removeEventListener("touchcancel", reset); reset();
    };
  }, [enabled, pageRef, onBack]);
}
