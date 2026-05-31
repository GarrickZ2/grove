import { useCallback, useRef, useState, useSyncExternalStore } from "react";

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

// ─── Shared store for useGlobalActiveChatId ──────────────────────────────
// Previously every caller (one per comment card / conversation item) installed
// its own 400ms interval + global click/resize listeners. In a review with many
// comments that meant N timers all polling the DOM. We hoist a single set of
// listeners to module scope and fan out to subscribers via useSyncExternalStore,
// so there is exactly one interval/listener set regardless of caller count.
let globalActiveChatId: string | null = null;
const activeChatSubscribers = new Set<() => void>();
let activeChatTeardown: (() => void) | null = null;

function computeActiveAndVisible(): string | null {
  if (typeof window === "undefined") return null;
  const id = (window as Window & { __groveActiveChatId?: string | null }).__groveActiveChatId || null;
  if (!id) return null;
  // The chat panel must actually be visible in the DOM (display !== none).
  const panelEl = document.querySelector('[data-grove-chat-panel="true"]');
  if (!panelEl) return null;
  if ((panelEl as HTMLElement).offsetParent === null) return null;
  return id;
}

function recomputeActiveChat() {
  const next = computeActiveAndVisible();
  if (next !== globalActiveChatId) {
    globalActiveChatId = next;
    activeChatSubscribers.forEach((fn) => fn());
  }
}

function subscribeActiveChat(onStoreChange: () => void): () => void {
  activeChatSubscribers.add(onStoreChange);
  if (!activeChatTeardown && typeof window !== "undefined") {
    window.addEventListener("grove-active-chat-changed", recomputeActiveChat);
    window.addEventListener("click", recomputeActiveChat);
    window.addEventListener("resize", recomputeActiveChat);
    const interval = setInterval(recomputeActiveChat, 400);
    recomputeActiveChat(); // initial
    activeChatTeardown = () => {
      window.removeEventListener("grove-active-chat-changed", recomputeActiveChat);
      window.removeEventListener("click", recomputeActiveChat);
      window.removeEventListener("resize", recomputeActiveChat);
      clearInterval(interval);
    };
  }
  return () => {
    activeChatSubscribers.delete(onStoreChange);
    if (activeChatSubscribers.size === 0 && activeChatTeardown) {
      activeChatTeardown();
      activeChatTeardown = null;
    }
  };
}

export function useGlobalActiveChatId(): string | null {
  return useSyncExternalStore(
    subscribeActiveChat,
    () => globalActiveChatId,
    () => null,
  );
}
