import { useEffect, useRef, type RefObject } from "react";

export interface PinchHandlers {
  /** Two fingers moved: zoom by `factor` around (x, y), in the element's own pixels, then move by (dx, dy). */
  onPinch: (pinch: { factor: number; x: number; y: number; dx: number; dy: number }) => void;
  /** One finger moved by (dx, dy). Return false to leave the touch to the element's own handling. */
  onPan?: (pan: { dx: number; dy: number }) => boolean;
  /** A second finger came down: whatever one finger had started is over. */
  onStart?: () => void;
}

/**
 * Pinch-to-zoom (and, optionally, one-finger pan) for a touch screen on an
 * element that zooms with the wheel on a desktop. Touches that become a pinch
 * never reach the element's own pointer handlers. The element needs
 * `touch-action: none` so the browser leaves the fingers to it.
 */
export function usePinchZoom(ref: RefObject<HTMLElement | null>, handlers: PinchHandlers, enabled = true) {
  const latest = useRef(handlers);
  useEffect(() => { latest.current = handlers; });

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const fingers = new Map<number, { x: number; y: number }>();
    // Fingers that took part in a pinch or a pan: their release is ours too.
    const claimed = new Set<number>();
    let last: { distance: number; x: number; y: number } | null = null;

    const local = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const pair = () => {
      const [a, b] = [...fingers.values()];
      return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      fingers.set(event.pointerId, local(event));
      if (fingers.size === 2) {
        latest.current.onStart?.();
        fingers.forEach((_, id) => claimed.add(id));
        last = pair();
        event.stopPropagation();
      } else if (fingers.size > 2) {
        event.stopPropagation();
      }
    };
    const move = (event: PointerEvent) => {
      const previous = fingers.get(event.pointerId);
      if (event.pointerType !== "touch" || !previous) return;
      const point = local(event);
      fingers.set(event.pointerId, point);
      if (fingers.size >= 2 && last) {
        const now = pair();
        latest.current.onPinch({ factor: now.distance / last.distance, x: last.x, y: last.y, dx: now.x - last.x, dy: now.y - last.y });
        last = now;
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (fingers.size === 1 && latest.current.onPan?.({ dx: point.x - previous.x, dy: point.y - previous.y })) {
        claimed.add(event.pointerId);
        event.stopPropagation();
        event.preventDefault();
      }
    };
    const up = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !fingers.has(event.pointerId)) return;
      fingers.delete(event.pointerId);
      last = fingers.size >= 2 ? pair() : null;
      if (claimed.delete(event.pointerId)) event.stopPropagation();
    };

    const options = { capture: true, passive: false } as const;
    element.addEventListener("pointerdown", down, options);
    element.addEventListener("pointermove", move, options);
    element.addEventListener("pointerup", up, options);
    element.addEventListener("pointercancel", up, options);
    return () => {
      element.removeEventListener("pointerdown", down, options);
      element.removeEventListener("pointermove", move, options);
      element.removeEventListener("pointerup", up, options);
      element.removeEventListener("pointercancel", up, options);
    };
  }, [ref, enabled]);
}
