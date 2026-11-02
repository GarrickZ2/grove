import { useCallback, useEffect, useState } from "react";
import { windowRange } from "./artifactsView";

/** Before the scroller is measured (and in jsdom), assume a tall dock. */
const FALLBACK_VIEWPORT = 720;

/** Scroll position and size of a scroll container. */
export function useScrollViewport() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!scroller) return;
    const measure = () => setSize({ width: scroller.clientWidth, height: scroller.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  // Scroll events already arrive at most once a frame; React batches the update.
  const onScroll = useCallback(() => {
    if (scroller) setScrollTop(scroller.scrollTop);
  }, [scroller]);

  const viewport = size.height > 0 ? size.height : FALLBACK_VIEWPORT;
  return { attach: setScroller, scroller, onScroll, scrollTop, viewport, width: size.width };
}

/**
 * Windowing for fixed-height rows: mounts only the rows in view plus
 * `overscan` each side, so a folder with thousands of files stays cheap.
 */
export function useWindowedRows(
  { scroller, scrollTop, viewport }: { scroller: HTMLDivElement | null; scrollTop: number; viewport: number },
  count: number,
  rowHeight: number,
  overscan = 6,
) {
  const { start, end } = windowRange(scrollTop, viewport, rowHeight, count, overscan);

  /** Scroll so `row` is fully in view (keyboard focus moves). */
  const reveal = useCallback((row: number) => {
    if (!scroller) return;
    const top = row * rowHeight;
    const bottom = top + rowHeight;
    if (top < scroller.scrollTop) scroller.scrollTo({ top });
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTo({ top: bottom - scroller.clientHeight });
  }, [scroller, rowHeight]);

  return { start, end, totalHeight: count * rowHeight, reveal };
}
