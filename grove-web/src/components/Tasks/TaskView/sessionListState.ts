export interface SessionListItem {
  id: string;
  /** Pinned sessions stay above the rest; each group is ordered by recency. */
  pinned?: boolean;
}

/** Index of the first unpinned session: where a recent unpinned one goes. */
function groupTop<T extends SessionListItem>(sessions: readonly T[], session: T): number {
  return session.pinned ? 0 : sessions.filter((item) => item.pinned).length;
}

/**
 * Reflect local activity immediately instead of waiting for the backend's
 * touch -> radio event -> full-list refetch round trip. A session only rises to
 * the top of its own group, so pinned sessions stay above the rest.
 */
export function promoteSession<T extends SessionListItem>(
  sessions: readonly T[],
  sessionId: string,
): T[] {
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index < 0) return [...sessions];
  const rest = [...sessions.slice(0, index), ...sessions.slice(index + 1)];
  const top = groupTop(rest, sessions[index]);
  return [...rest.slice(0, top), sessions[index], ...rest.slice(top)];
}

/**
 * A recency refresh may reorder sessions, but it must not temporarily evict
 * the active session. Selection is an explicit user/lifecycle decision, not a
 * side effect of list ordering.
 */
export function preserveActiveSessionInRefresh<T extends SessionListItem>(
  fresh: readonly T[],
  activeId: string | null,
  activeSession: T | undefined,
  activeWasArchived: boolean,
): T[] {
  if (
    !activeId ||
    !activeSession ||
    activeWasArchived ||
    fresh.some((session) => session.id === activeId)
  ) {
    return [...fresh];
  }
  const top = groupTop(fresh, activeSession);
  return [...fresh.slice(0, top), activeSession, ...fresh.slice(top)];
}

/** Runtime state is newer than a switch-time UI snapshot. */
export function resolveRestoredBusy(
  runtimeBusy: boolean | undefined,
  cachedBusy: boolean | undefined,
): boolean {
  return runtimeBusy ?? cachedBusy ?? false;
}

/** Live transcript state is newer than a switch-time UI snapshot. */
export function resolveRestoredMessages<T>(
  runtimeMessages: T[] | undefined,
  cachedMessages: T[] | undefined,
): T[] {
  return runtimeMessages ?? cachedMessages ?? [];
}
