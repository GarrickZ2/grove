import { useEffect } from "react";
import type { MutableRefObject } from "react";

interface Params {
  activeChatId: string | null;
  hasMessages: boolean;
  requestBottom: (behavior: "auto" | "smooth") => void;
  initialPinChatIdRef: MutableRefObject<string | null>;
  setShowScrollToBottom: (v: boolean) => void;
}

/**
 * Starts exactly one bottom-reattachment transaction when loaded history
 * first becomes available for a chat. TaskChat owns every subsequent scroll.
 */
export function useChatPositioning({
  activeChatId,
  hasMessages,
  requestBottom,
  initialPinChatIdRef,
  setShowScrollToBottom,
}: Params): void {
  useEffect(() => {
    if (!hasMessages) {
      initialPinChatIdRef.current = null;
      // An empty transcript has nothing to scroll, so Virtuoso never emits
      // the bottom callbacks that would clear a stale pill left over from
      // the previous chat — clear it here instead.
      setShowScrollToBottom(false);
      return;
    }
    if (initialPinChatIdRef.current === activeChatId) return;
    initialPinChatIdRef.current = activeChatId;
    setShowScrollToBottom(false);

    let cancelled = false;
    let rafId: number | null = null;

    // One request starts reattachment. Subsequent estimate corrections are
    // coalesced by TaskChat's single bottom controller; this hook must not run
    // its own multi-frame scroll loop.
    rafId = requestAnimationFrame(() => {
      if (!cancelled) requestBottom("auto");
    });

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    activeChatId,
    hasMessages,
    requestBottom,
    initialPinChatIdRef,
    setShowScrollToBottom,
  ]);
}
