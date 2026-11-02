import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const GAP = 8;
const MARGIN = 12;
const PREFERRED = 480;

/**
 * Open a composer popover upward (the docked composer) unless there's more
 * room below (the New page's centred composer), and cap it to that room.
 */
export function usePopPlacement(anchorRef: RefObject<HTMLElement | null>, open: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.top - GAP - MARGIN;
      const below = window.innerHeight - rect.bottom - GAP - MARGIN;
      const up = above >= Math.min(PREFERRED, 320) || above >= below;
      const room = Math.max(160, Math.min(PREFERRED, up ? above : below));
      setStyle(up ? { maxHeight: room } : { maxHeight: room, top: `calc(100% + ${GAP}px)`, bottom: "auto" });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef, open]);
  return open ? style : undefined;
}
