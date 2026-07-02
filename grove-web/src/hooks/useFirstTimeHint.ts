import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One-shot "have we shown this hint before" gate.
 *
 * Used by the Dynamic Island sidebar to surface a brief tooltip the first
 * time the user enters island mode, so they learn that hovering expands
 * the pill. Persists a flag in localStorage so it shows at most once
 * per user per key, across sessions.
 *
 * Contract:
 *   const hint = useFirstTimeHint("sidebar.island.hoverHint");
 *   hint.visible   — true for ~2.5s after `show()` if never shown before
 *   hint.show()    — fire the hint (no-op if already seen)
 *   hint.dismiss() — hide immediately (also marks seen)
 *
 * SSR-safe: all localStorage access is guarded by `typeof window`.
 */
export function useFirstTimeHint(storageKey: string, autoHideMs = 2500) {
  const [visible, setVisible] = useState(false);
  const seenRef = useRef<boolean | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      seenRef.current = window.localStorage.getItem(storageKey) === "1";
    } catch {
      seenRef.current = false;
    }
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [storageKey]);

  const markSeen = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, "1");
    } catch {
      /* ignore quota / private mode */
    }
    seenRef.current = true;
  }, [storageKey]);

  const show = useCallback(() => {
    if (seenRef.current) return;
    markSeen();
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), autoHideMs);
  }, [autoHideMs, markSeen]);

  const dismiss = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setVisible(false);
  }, []);

  return { visible, show, dismiss };
}