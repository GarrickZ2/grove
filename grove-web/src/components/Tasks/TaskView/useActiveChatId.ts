import { useCallback, useRef, useState, useEffect } from "react";

interface Result {
  activeChatId: string | null;
  /** Synchronously read the latest active chat id, even before React flushes. */
  getActiveChatId: () => string | null;
  /** Imperative setter that updates state AND the latest-id mirror in one go. */
  setActiveChatId: (id: string | null) => void;
}

/**
 * Co-locates `activeChatId` state with a synchronously-mirrored ref so async
 * code paths (WS callbacks, history loaders) can compare against the *latest*
 * id without waiting for React to flush the state update.
 *
 * Returns a getter rather than exposing the ref directly — that way
 * callers don't trigger React Compiler's "manual memoization could not be
 * preserved" bailout when they include `getActiveChatId` in deps.
 */
export function useActiveChatId(initial: string | null = null): Result {
  const [activeChatId, setActiveChatIdState] = useState<string | null>(initial);
  const ref = useRef<string | null>(initial);

  const setActiveChatId = useCallback((id: string | null) => {
    ref.current = id;
    setActiveChatIdState(id);
    if (typeof window !== "undefined") {
      (window as Window & { __groveActiveChatId?: string | null }).__groveActiveChatId = id;
      window.dispatchEvent(new CustomEvent("grove-active-chat-changed", { detail: id }));
    }
  }, []);

  const getActiveChatId = useCallback(() => ref.current, []);

  return { activeChatId, getActiveChatId, setActiveChatId };
}

export function useGlobalActiveChatId(): string | null {
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const checkActiveAndVisible = () => {
      const globalActiveId = (window as Window & { __groveActiveChatId?: string | null }).__groveActiveChatId || null;
      if (!globalActiveId) {
        setActiveChatId(null);
        return;
      }

      // Check if the chat panel is actually visible in the DOM (display !== none)
      const panelEl = document.querySelector('[data-grove-chat-panel="true"]');
      if (panelEl) {
        const isVisible = (panelEl as HTMLElement).offsetParent !== null;
        if (!isVisible) {
          setActiveChatId(null);
          return;
        }
      } else {
        // If the component is not in DOM at all
        setActiveChatId(null);
        return;
      }

      setActiveChatId(globalActiveId);
    };

    const handleChanged = () => {
      checkActiveAndVisible();
    };

    window.addEventListener("grove-active-chat-changed", handleChanged);
    window.addEventListener("click", checkActiveAndVisible);
    window.addEventListener("resize", checkActiveAndVisible);

    // Initial check
    checkActiveAndVisible();

    // Check periodically in case layout changes without click/resize
    const interval = setInterval(checkActiveAndVisible, 400);

    return () => {
      window.removeEventListener("grove-active-chat-changed", handleChanged);
      window.removeEventListener("click", checkActiveAndVisible);
      window.removeEventListener("resize", checkActiveAndVisible);
      clearInterval(interval);
    };
  }, []);

  return activeChatId;
}
