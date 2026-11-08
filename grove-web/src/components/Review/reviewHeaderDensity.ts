import { useEffect, useState } from 'react';

/* How much of the Orbit Review toolbar fits inline in the panel header. */

/** `wide`: everything inline. `medium`: no arrow, no Unified/Split. `narrow`: also fold ↑↓ and comments. `compact`: also fold Changes/All files, Project icon only. */
export type ReviewHeaderDensity = 'wide' | 'medium' | 'narrow' | 'compact';

export const REVIEW_HEADER_WIDE_PX = 980;
export const REVIEW_HEADER_MEDIUM_PX = 760;
export const REVIEW_HEADER_NARROW_PX = 700;

export function reviewHeaderDensity(width: number | null): ReviewHeaderDensity {
  if (width === null || width >= REVIEW_HEADER_WIDE_PX) return 'wide';
  if (width >= REVIEW_HEADER_MEDIUM_PX) return 'medium';
  return width >= REVIEW_HEADER_NARROW_PX ? 'narrow' : 'compact';
}

/** Width of an element, tracked with ResizeObserver (null until measured / unsupported). */
export function useElementWidth(el: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}
