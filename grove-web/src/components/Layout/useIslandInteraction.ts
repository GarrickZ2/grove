import { useCallback, useEffect, useRef, useState } from "react";

/** Hover previews may expire; deliberate pointer/keyboard interaction stays open. */
export function useIslandInteraction(enabled: boolean) {
  const surfaceRef = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const pinnedRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    cancelHide();
    pinnedRef.current = false;
    setIsOpen(false);
  }, [cancelHide]);

  const enter = useCallback(() => {
    cancelHide();
    setIsOpen(true);
  }, [cancelHide]);

  const pin = useCallback(() => {
    cancelHide();
    // Synchronous: a mouseleave from the ensuing layout change must see this.
    pinnedRef.current = true;
    setIsOpen(true);
  }, [cancelHide]);

  const leave = useCallback(() => {
    cancelHide();
    if (pinnedRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      if (!pinnedRef.current) setIsOpen(false);
    }, 180);
  }, [cancelHide]);

  useEffect(() => {
    if (!enabled || !isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !surfaceRef.current?.contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, isOpen, close]);

  useEffect(() => {
    // Reset interaction state when the sidebar leaves Island mode.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!enabled) close();
    return cancelHide;
  }, [enabled, close, cancelHide]);

  return { surfaceRef, isOpen, enter, leave, pin, close };
}
