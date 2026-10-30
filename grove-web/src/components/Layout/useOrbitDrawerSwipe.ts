import { useEffect, type RefObject } from "react";

/** Movement before a touch counts as a swipe rather than a tap. */
const SLOP_PX = 10;
/** A swipe must be this much more horizontal than vertical, so vertical scrolling stays untouched. */
const HORIZONTAL_BIAS = 1.2;
/** Release past this share of the drawer (from where it started) to switch states. */
const SWITCH_RATIO = 0.35;
/** A flick at least this fast (px/ms) switches regardless of distance. */
const FLING_PX_PER_MS = 0.45;

/** Whether something under the finger can still scroll the way the finger moves; it keeps the swipe. */
function scrollsHorizontally(from: Element | null, deltaX: number): boolean {
  for (let node = from; node && node !== document.body; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || node.scrollWidth <= node.clientWidth + 1) continue;
    const overflow = getComputedStyle(node).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    // Finger moving right reveals content on the left, and vice versa.
    if (deltaX > 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
  }
  return false;
}

interface DrawerSwipeOptions {
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drawerRef: RefObject<HTMLElement | null>;
  /** Where a swipe can open the drawer from. */
  pageRef: RefObject<HTMLElement | null>;
  scrimRef: RefObject<HTMLElement | null>;
}

/**
 * Orbit's phone drawer follows the finger: a rightward swipe anywhere on the
 * page pulls it out, a leftward swipe on it (or the dimmed page) pushes it
 * back. The drawer is moved through inline styles while dragging; on release
 * they are dropped so its CSS transition settles it into the chosen state.
 */
export function useOrbitDrawerSwipe({ enabled, open, onOpenChange, drawerRef, pageRef, scrimRef }: DrawerSwipeOptions) {
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number; target: Element } | null = null;
    let dragging = false;
    let width = 0;
    let offset = 0;
    let lastX = 0;
    let lastTime = 0;
    let velocity = 0;

    const setStyles = (drawerOffset: number | null) => {
      const drawer = drawerRef.current;
      const scrim = scrimRef.current;
      if (drawerOffset === null) {
        for (const element of [drawer, scrim]) element?.style.removeProperty("transition");
        drawer?.style.removeProperty("transform");
        drawer?.style.removeProperty("visibility");
        scrim?.style.removeProperty("opacity");
        scrim?.style.removeProperty("visibility");
        return;
      }
      if (drawer) Object.assign(drawer.style, { transition: "none", visibility: "visible", transform: `translateX(${drawerOffset}px)` });
      if (scrim) Object.assign(scrim.style, { transition: "none", visibility: "visible", opacity: String(1 + drawerOffset / width) });
    };

    const onStart = (event: TouchEvent) => {
      start = null;
      dragging = false;
      if (event.touches.length !== 1) return;
      const target = event.target as Element;
      const inArea = open
        ? drawerRef.current?.contains(target) || scrimRef.current?.contains(target)
        : pageRef.current?.contains(target);
      // Text fields keep their own swipes (cursor moves, selection).
      if (!inArea || target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, target };
      lastX = touch.clientX;
      lastTime = event.timeStamp;
      velocity = 0;
    };

    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      if (!dragging) {
        if (Math.abs(deltaX) < SLOP_PX && Math.abs(deltaY) < SLOP_PX) return;
        const horizontal = Math.abs(deltaX) > Math.abs(deltaY) * HORIZONTAL_BIAS;
        const towardSwitch = open ? deltaX < 0 : deltaX > 0;
        width = drawerRef.current?.offsetWidth ?? 0;
        if (!horizontal || !towardSwitch || !width || scrollsHorizontally(start.target, deltaX)) {
          start = null;
          return;
        }
        dragging = true;
      }
      // Ours now: keep the page from scrolling under the drawer.
      event.preventDefault();
      offset = Math.min(0, Math.max(-width, (open ? 0 : -width) + deltaX));
      const elapsed = event.timeStamp - lastTime;
      if (elapsed > 0) velocity = (touch.clientX - lastX) / elapsed;
      lastX = touch.clientX;
      lastTime = event.timeStamp;
      setStyles(offset);
    };

    const onEnd = () => {
      if (!start) return;
      const wasDragging = dragging;
      start = null;
      dragging = false;
      if (!wasDragging) return;
      const shown = 1 + offset / width;
      const nextOpen = open
        ? !(velocity < -FLING_PX_PER_MS || shown < 1 - SWITCH_RATIO)
        : velocity > FLING_PX_PER_MS || shown > SWITCH_RATIO;
      setStyles(null);
      if (nextOpen !== open) onOpenChange(nextOpen);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
      setStyles(null);
    };
  }, [enabled, open, onOpenChange, drawerRef, pageRef, scrimRef]);
}
