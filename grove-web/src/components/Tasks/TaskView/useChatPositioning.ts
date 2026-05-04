import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";

interface Params {
  activeChatId: string | null;
  messagesLength: number;
  scrollMessagesToBottom: (behavior: "auto" | "smooth") => void;
  // Refs that are owned by TaskChat but flipped here as part of the chat-
  // switch positioning sequence.
  initialPinChatIdRef: MutableRefObject<string | null>;
  suppressNextSmoothScrollRef: MutableRefObject<boolean>;
  prevAutoScrollTailRef: MutableRefObject<string>;
  autoScrollTailSignatureRef: RefObject<string>;
  autoStickToBottomRef: MutableRefObject<boolean>;
  setShowScrollToBottom: (v: boolean) => void;
}

interface Result {
  chatPositioning: boolean;
  /**
   * Call from `handleAtBottomStateChange` (or wherever Virtuoso confirms
   * we've landed at the bottom) to fade the list in early instead of
   * waiting for the hard fallback timeout.
   */
  notifyPositionedAtBottom: () => void;
}

/**
 * Manages the chat-switch "scroll → reveal" sequence. Pulled out of
 * TaskChat so the captured-mutable `let` pattern (cancelled / rafId /
 * revealTimer / attempts) lives in a small hook that React Compiler
 * can analyze independently of TaskChat's main body.
 */
export function useChatPositioning({
  activeChatId,
  messagesLength,
  scrollMessagesToBottom,
  initialPinChatIdRef,
  suppressNextSmoothScrollRef,
  prevAutoScrollTailRef,
  autoScrollTailSignatureRef,
  autoStickToBottomRef,
  setShowScrollToBottom,
}: Params): Result {
  const [chatPositioning, setChatPositioning] = useState(false);
  const onPositionedAtBottomRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (messagesLength === 0) return;
    if (initialPinChatIdRef.current === activeChatId) return;
    initialPinChatIdRef.current = activeChatId;
    suppressNextSmoothScrollRef.current = true;
    prevAutoScrollTailRef.current = autoScrollTailSignatureRef.current ?? "";
    autoStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setChatPositioning(true);

    let cancelled = false;
    let rafId: number | null = null;
    let revealTimer: number | null = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 12;
    const HARD_FALLBACK_MS = 180;

    const reveal = () => {
      if (cancelled) return;
      onPositionedAtBottomRef.current = null;
      setChatPositioning(false);
    };
    onPositionedAtBottomRef.current = reveal;
    revealTimer = window.setTimeout(reveal, HARD_FALLBACK_MS);

    const tick = () => {
      if (cancelled) return;
      scrollMessagesToBottom("auto");
      attempts += 1;
      if (attempts < MAX_ATTEMPTS) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (revealTimer !== null) clearTimeout(revealTimer);
      onPositionedAtBottomRef.current = null;
    };
  }, [
    activeChatId,
    messagesLength,
    scrollMessagesToBottom,
    initialPinChatIdRef,
    suppressNextSmoothScrollRef,
    prevAutoScrollTailRef,
    autoScrollTailSignatureRef,
    autoStickToBottomRef,
    setShowScrollToBottom,
  ]);

  const notifyPositionedAtBottom = useCallback(() => {
    onPositionedAtBottomRef.current?.();
  }, []);

  return { chatPositioning, notifyPositionedAtBottom };
}
