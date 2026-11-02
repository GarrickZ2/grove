import { useEffect, useState } from "react";

/**
 * The element with `id` (a portal target the app shell renders, e.g. the Orbit
 * window-header toolbar slot), or null. The shell may render that element
 * after this component mounts, or replace it, so while it is missing or
 * detached we watch the DOM until it shows up. `recheck` re-resolves it
 * (e.g. when a keep-alive page becomes visible again).
 */
export function useSlotElement(id: string | null, recheck?: unknown): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    let observer: MutationObserver | null = null;
    const resolve = () => {
      const found = id ? document.getElementById(id) : null;
      if (!cancelled) setEl((prev) => (prev === found ? prev : found));
      return found;
    };
    void Promise.resolve().then(() => {
      if (cancelled || !id || resolve()) return;
      observer = new MutationObserver(() => {
        if (resolve()) { observer?.disconnect(); observer = null; }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [id, recheck]);
  return el?.isConnected ? el : null;
}
