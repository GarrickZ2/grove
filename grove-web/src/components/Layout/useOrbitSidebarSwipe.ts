import { useEffect } from "react";
import { scrollsHorizontally } from "./useOrbitDrawerSwipe";

const SLOP_PX = 10;
const HORIZONTAL_BIAS = 1.2;
/** How far a swipe must travel to switch the sidebar. */
const SWITCH_PX = 56;
/** Touches that are already something else: text, drawing, and drag handles. */
const NOT_A_SWIPE = 'input, textarea, select, [contenteditable="true"], canvas, .xterm, .excalidraw, [role="separator"], .ide-resizer, .flexlayout__splitter, .flexlayout__tab_button, .sidebar-resizer';

interface SidebarSwipeOptions {
  enabled: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

/**
 * Orbit's desktop layout on a touch screen (a tablet, or a foldable's inner
 * screen): a rightward swipe on the page shows a collapsed sidebar, a leftward
 * swipe on the sidebar collapses it. Unlike the phone drawer it doesn't follow
 * the finger, because the sidebar pushes the page rather than sliding over it.
 */
export function useOrbitSidebarSwipe({ enabled, collapsed, onCollapsedChange }: SidebarSwipeOptions) {
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number; target: Element } | null = null;
    let horizontal = false;

    const onStart = (event: TouchEvent) => {
      start = null;
      horizontal = false;
      if (event.touches.length !== 1) return;
      const target = event.target as Element;
      if (target.closest(NOT_A_SWIPE)) return;
      if (!collapsed && !target.closest("[data-grove-sidebar]")) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, target };
    };

    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      if (!horizontal) {
        if (Math.abs(deltaX) < SLOP_PX && Math.abs(deltaY) < SLOP_PX) return;
        const toward = collapsed ? deltaX > 0 : deltaX < 0;
        if (Math.abs(deltaX) <= Math.abs(deltaY) * HORIZONTAL_BIAS || !toward || scrollsHorizontally(start.target, deltaX)) {
          start = null;
          return;
        }
        horizontal = true;
      }
      if (Math.abs(deltaX) < SWITCH_PX) return;
      start = null;
      onCollapsedChange(!collapsed);
    };

    const onEnd = () => { start = null; };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, collapsed, onCollapsedChange]);
}
