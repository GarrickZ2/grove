import { useCallback, useRef, useState } from "react";

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
  }, []);

  const getActiveChatId = useCallback(() => ref.current, []);

  return { activeChatId, getActiveChatId, setActiveChatId };
}
