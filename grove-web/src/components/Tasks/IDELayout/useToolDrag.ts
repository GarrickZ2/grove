import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { MORE, type PanelMove } from "../PanelSystem/panelOrder";

/** A press becomes a drag after this much movement. */
const SLOP = 5;

interface DropLine { axis: "x" | "y"; left: number; top: number; length: number }

interface DragState {
  key: string;
  x: number;
  y: number;
  /** The panel it would land beside, or MORE. */
  target: string | null;
  line: DropLine | null;
}

interface Press {
  key: string;
  pointerId: number;
  x: number;
  y: number;
  active: boolean;
  move: PanelMove | null;
  onStrip: boolean;
}

interface Spot { key: string; rect: DOMRect }

/** What there is to drop on, as laid out now. */
export interface DropZones {
  /** The toolbar's own panels. An open one from More isn't among them. */
  bar: Spot[];
  strip: DOMRect | null;
  moreButton: DOMRect | null;
  /** The panels under More, when its menu is open. */
  menu: Spot[];
  menuBox: DOMRect | null;
}

const visible = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => el.getClientRects().length > 0);
const spots = (selector: string): Spot[] => visible(selector).map((el) => ({ key: el.dataset.toolDrag ?? "", rect: el.getBoundingClientRect() }));
const box = (selector: string) => visible(selector)[0]?.getBoundingClientRect() ?? null;

function zones(): DropZones {
  return {
    bar: spots(".ows-tools .ows-tb[data-tool-pinned]"),
    strip: box(".ows-tools.has-names"),
    moreButton: box("[data-tool-more]"),
    menu: spots(".ows-tools .oui-panel-menu-item[data-tool-drag]:not([data-tool-pinned])"),
    menuBox: box(".ows-tools .oui-panel-menu"),
  };
}

const within = (p: { x: number; y: number }, r: DOMRect | null, dx: number, dy: number) =>
  !!r && p.x >= r.left - dx && p.x <= r.right + dx && p.y >= r.top - dy && p.y <= r.bottom + dy;

/**
 * Where a panel dropped at this point goes, and the line that shows it. Null
 * away from the toolbar and its menu. The toolbar's own panels that don't fit
 * lead the menu; below them the menu is More's.
 */
export function dropSpot(point: { x: number; y: number }, { bar, strip, moreButton, menu, menuBox }: DropZones): { target: string; side: "before" | "after"; onStrip: boolean; line: DropLine | null } | null {
  if (within(point, moreButton, 0, 6)) return { target: MORE, side: "after", onStrip: false, line: null };
  if (menuBox && within(point, menuBox, 8, 6)) {
    const last = menu[menu.length - 1];
    if (!last) return { target: MORE, side: "after", onStrip: false, line: null };
    const next = menu.find((spot) => point.y < spot.rect.top + spot.rect.height / 2);
    const { rect, key } = next ?? last;
    return {
      target: key,
      side: next ? "before" : "after",
      onStrip: false,
      line: { axis: "y", left: rect.left, top: next ? rect.top : rect.bottom, length: rect.right - rect.left },
    };
  }
  if (strip && within(point, strip, 40, 12)) {
    const next = bar.find((spot) => point.x < spot.rect.left + spot.rect.width / 2);
    if (next) return { target: next.key, side: "before", onStrip: true, line: { axis: "x", left: next.rect.left - 1, top: next.rect.top, length: next.rect.height } };
    const last = bar[bar.length - 1];
    // Past the last one it goes right after it; into an empty strip, before More.
    return last
      ? { target: last.key, side: "after", onStrip: true, line: { axis: "x", left: last.rect.right + 1, top: last.rect.top, length: last.rect.height } }
      : { target: MORE, side: "before", onStrip: true, line: moreButton ? { axis: "x", left: moreButton.left - 4, top: moreButton.top, length: moreButton.height } : null };
  }
  return null;
}

/** Drag a panel to another place in the toolbar or its More menu (mouse or pen). */
export function useToolDrag({ onStart, onOverMore, onMove }: {
  onStart: () => void;
  /** The pointer is over the closed More button. */
  onOverMore: () => void;
  onMove: (move: PanelMove, onStrip: boolean) => void;
}) {
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const handlers = useRef({ onStart, onOverMore, onMove });
  useEffect(() => { handlers.current = { onStart, onOverMore, onMove }; });

  const finish = useCallback((commit: boolean) => {
    const current = press.current;
    press.current = null;
    if (!current?.active) return;
    // Swallow the click the release would otherwise send to the button.
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    document.body.classList.remove("ows-dragging");
    setDragging(null);
    if (commit && current.move) handlers.current.onMove(current.move, current.onStrip);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = press.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!current.active) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) <= SLOP) return;
        current.active = true;
        document.body.classList.add("ows-dragging");
        handlers.current.onStart();
      }
      const point = { x: event.clientX, y: event.clientY };
      const moreButton = visible("[data-tool-more]")[0];
      const more = moreButton?.getBoundingClientRect();
      if (more && moreButton?.getAttribute("aria-expanded") === "false" && point.x >= more.left && point.x <= more.right && point.y >= more.top - 6 && point.y <= more.bottom + 6) handlers.current.onOverMore();
      const spot = dropSpot(point, zones());
      current.move = spot && spot.target !== current.key ? { key: current.key, target: spot.target, side: spot.side } : null;
      current.onStrip = !!spot?.onStrip;
      setDragging({ key: current.key, ...point, target: current.move?.target ?? null, line: current.move && spot ? spot.line : null });
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === press.current?.pointerId) finish(event.type === "pointerup");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !press.current?.active) return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", escape, true);
      document.body.classList.remove("ows-dragging");
    };
  }, [finish]);

  const itemProps = (key: string, pinned: boolean) => ({
    "data-tool-drag": key,
    "data-tool-pinned": pinned ? "" : undefined,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.pointerType === "touch" || press.current) return;
      press.current = {
        key,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        active: false,
        move: null,
        onStrip: false,
      };
    },
    onClickCapture: (event: ReactMouseEvent) => {
      if (!suppressClick.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  return { dragging, itemProps };
}
