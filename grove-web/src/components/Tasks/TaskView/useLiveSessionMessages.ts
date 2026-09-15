import { useCallback, useLayoutEffect, useRef } from "react";

import { resolveRestoredMessages } from "./sessionListState";

/**
 * Owns the visible transcript and its live per-session snapshots.
 *
 * The ordinary per-chat cache is captured for UI switching and may be stale.
 * This hook commits every rendered transcript before another browser event can
 * restore a session, so lifecycle refreshes cannot replace live history with
 * an older switch snapshot.
 */
export function useLiveSessionMessages<T>(
  activeSessionId: string | null,
  messages: T[],
) {
  const runtimeMessagesRef = useRef<Map<string, T[]>>(new Map());

  useLayoutEffect(() => {
    if (activeSessionId) {
      runtimeMessagesRef.current.set(activeSessionId, messages);
    }
  }, [activeSessionId, messages]);

  const resolveMessages = useCallback(
    (sessionId: string, cachedMessages: T[] | undefined) =>
      resolveRestoredMessages(
        runtimeMessagesRef.current.get(sessionId),
        cachedMessages,
      ),
    [],
  );

  const forgetMessages = useCallback((sessionId: string) => {
    runtimeMessagesRef.current.delete(sessionId);
  }, []);

  const updateMessages = useCallback((sessionId: string, nextMessages: T[]) => {
    runtimeMessagesRef.current.set(sessionId, nextMessages);
  }, []);

  return { resolveMessages, forgetMessages, updateMessages };
}
