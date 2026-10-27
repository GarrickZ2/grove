import { useCallback, useEffect, useRef } from "react";

/** Dismiss only when interaction leaves the composer, including its portals. */
export function useComposerInteractionBoundary(enabled: boolean, onOutside: () => void) {
  const insideEvents = useRef(new WeakSet<Event>());
  const markInside = useCallback((event: { nativeEvent: Event }) => {
    insideEvents.current.add(event.nativeEvent);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const dismissOutside = (event: Event) => {
      if (!insideEvents.current.has(event)) onOutside();
    };
    // React capture handlers run before these document bubble listeners,
    // including for portaled menus. No reliance on buttons receiving focus:
    // Safari can leave activeElement at body after a toolbar click.
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [enabled, onOutside]);

  return markInside;
}
