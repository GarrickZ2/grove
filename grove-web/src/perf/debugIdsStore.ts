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
 * when value becomes null. Compiled out by Vite tree-shaking in non-perf
 * builds via the module-level `IS_PERF` constant.
 */
const IS_PERF = import.meta.env.MODE === "perf";

export function useReportDebugId(level: DebugIdLevel, value: string | null) {
  // Effect is registered conditionally so prod builds don't pay the
  // per-render diff cost. Hook order is stable per call site since the
  // `IS_PERF` constant is fixed at build time.
  if (IS_PERF) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      setDebugId(level, value);
      return () => {
        setDebugId(level, null);
      };
    }, [level, value]);
  }
}
