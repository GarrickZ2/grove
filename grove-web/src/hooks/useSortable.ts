import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** Mouse drags start after this much movement; touch drags after a still long press. */
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 380;

interface Gesture {
  id: string;
  pointerId: number;
  touch: boolean;
  x: number;
  y: number;
  timer?: number;
  active: boolean;
  moved: boolean;
  /** Slot rectangles in the original order, measured when the drag starts. */
  slots: DOMRect[];
  from: number;
  to: number;
  element: HTMLElement;
}

/**
 * Pointer-driven reordering for a list or grid that works with mouse and
 * touch. A mouse drags once it moves; a finger first long-presses (a still
 * long press that is released opens `onLongPress` instead, like iOS). While
 * dragging, the order previews live and the dragged item follows the
 * pointer; `onReorder` gets the new order on release.
 */
export function useSortable({ ids, onReorder, onLongPress, enabled = true }: {
  ids: string[];
  onReorder: (ids: string[]) => void;
  onLongPress?: (id: string, at: { x: number; y: number }) => void;
  enabled?: boolean;
}) {
  const elements = useRef(new Map<string, HTMLElement>());
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<{ order: string[]; id: string; offset: { x: number; y: number } } | null>(null);
  /** Swallows the click a finished drag would otherwise send to the item. */
  const suppressClick = useRef(false);

  const finish = useCallback((commit: boolean) => {
    const current = gesture.current;
    gesture.current = null;
    if (!current) return;
    window.clearTimeout(current.timer);
    if (current.active) {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      if (commit && current.to !== current.from) {
        const order = ids.filter((id) => id !== current.id);
        order.splice(current.to, 0, current.id);
        onReorder(order);
      }
    }
    setPreview(null);
  }, [ids, onReorder]);

  const activate = useCallback((current: Gesture) => {
    current.active = true;
    current.slots = ids.map((id) => elements.current.get(id)?.getBoundingClientRect() ?? new DOMRect());
    current.from = current.to = ids.indexOf(current.id);
    try { current.element.setPointerCapture(current.pointerId); } catch { /* The pointer may already be gone. */ }
    if (current.touch) navigator.vibrate?.(8);
    setPreview({ order: ids, id: current.id, offset: { x: 0, y: 0 } });
  }, [ids]);

  useEffect(() => {
    // A drag owns the touch: stop the page from scrolling under it.
    const touchMove = (event: TouchEvent) => { if (gesture.current?.active) event.preventDefault(); };
    window.addEventListener("touchmove", touchMove, { passive: false });
    return () => window.removeEventListener("touchmove", touchMove);
  }, []);

  const move = useCallback((event: PointerEvent) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!current.active) {
      if (Math.hypot(dx, dy) <= (current.touch ? TOUCH_SLOP : MOUSE_SLOP)) return;
      // A finger that moves before the long press is scrolling or swiping.
      if (current.touch) { finish(false); return; }
      activate(current);
    }
    current.moved = true;
    const origin = current.slots[current.from];
    const cx = origin.left + origin.width / 2 + dx, cy = origin.top + origin.height / 2 + dy;
    let best = current.to, distance = Infinity;
    current.slots.forEach((slot, index) => {
      const d = Math.hypot(slot.left + slot.width / 2 - cx, slot.top + slot.height / 2 - cy);
      if (d < distance) { distance = d; best = index; }
    });
    current.to = best;
    const order = ids.filter((id) => id !== current.id);
    order.splice(best, 0, current.id);
    // The item now sits in slot `best`; shift it back so it stays under the pointer.
    const target = current.slots[best];
    setPreview({ order, id: current.id, offset: { x: origin.left - target.left + dx, y: origin.top - target.top + dy } });
  }, [activate, finish, ids]);

  const up = useCallback((event: PointerEvent) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (current.active && current.touch && !current.moved) {
      // Lifted without moving: the long press opens the item's actions.
      finish(false);
      onLongPress?.(current.id, { x: event.clientX, y: event.clientY });
      return;
    }
    finish(event.type === "pointerup");
  }, [finish, onLongPress]);

  useEffect(() => {
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [move, up]);

  const itemProps = (id: string) => ({
    ref: (element: HTMLElement | null) => { if (element) elements.current.set(id, element); else elements.current.delete(id); },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || gesture.current) return;
      const touch = event.pointerType !== "mouse";
      const current: Gesture = { id, pointerId: event.pointerId, touch, x: event.clientX, y: event.clientY, active: false, moved: false, slots: [], from: 0, to: 0, element: event.currentTarget };
      gesture.current = current;
      if (touch) current.timer = window.setTimeout(() => { if (gesture.current === current) activate(current); }, LONG_PRESS_MS);
    },
    onClickCapture: (event: React.MouseEvent) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } },
    // Touch long presses are ours; don't let the browser open its own menu.
    onContextMenuCapture: (event: React.MouseEvent) => { if (gesture.current?.touch) { event.preventDefault(); event.stopPropagation(); } },
  });

  return {
    /** The order to render: the live preview while dragging. */
    order: preview?.order ?? ids,
    draggingId: preview?.id ?? null,
    /** Translation for the dragged item so it tracks the pointer. */
    offset: preview?.offset ?? { x: 0, y: 0 },
    /** True once a press has become a drag; swipes should yield to it. */
    isDragging: () => !!gesture.current?.active,
    itemProps,
  };
}
