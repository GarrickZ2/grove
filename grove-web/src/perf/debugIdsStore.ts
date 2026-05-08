/**
 * Tiny pub/sub store for the three identifiers needed to locate a chat's
 * data on disk:
 *   - projectId = FNV-1a hash of canonical project path → `~/.grove/projects/<id>/`
 *   - taskId    = uuid for the worktree task              → `tasks/<task>/`
 *   - chatId    = uuid for the focused chat               → `chats/<chat>/`
 *
 * Surfaces report what they know via `useReportDebugId(level, value)`. The
 * perf-panel pill subscribes and shows whichever levels are currently set —
 * project view shows only proj, task view adds task, chat focus adds chat.
 */
import { useEffect, useSyncExternalStore } from "react";

export type DebugIdLevel = "projectId" | "taskId" | "chatId";

export interface DebugIdsState {
  projectId: string | null;
  taskId: string | null;
  chatId: string | null;
}

let state: DebugIdsState = { projectId: null, taskId: null, chatId: null };
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function setDebugId(level: DebugIdLevel, value: string | null) {
  if (state[level] === value) return;
  state = { ...state, [level]: value };
  notify();
}

export function getDebugIds(): DebugIdsState {
  return state;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDebugIds(): DebugIdsState {
  return useSyncExternalStore(subscribe, getDebugIds, getDebugIds);
}

/**
 * Report a single id from the surface that owns it. Clears on unmount or
 * when value becomes null. No-op outside perf builds — the effect runs but
 * the store stays empty since nothing reads it.
 */
export function useReportDebugId(level: DebugIdLevel, value: string | null) {
  useEffect(() => {
    if (import.meta.env.MODE !== "perf") return;
    setDebugId(level, value);
    return () => {
      setDebugId(level, null);
    };
  }, [level, value]);
}
