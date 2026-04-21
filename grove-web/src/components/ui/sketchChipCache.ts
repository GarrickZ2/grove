import { listSketches } from "../../api";

type TaskKey = string;

// Module-level cache: taskKey -> (sketchId -> name)
const sketchNameCache = new Map<TaskKey, Map<string, string>>();
const inflight = new Map<TaskKey, Promise<void>>();
const subscribers = new Map<TaskKey, Set<() => void>>();
const lastFetchedAt = new Map<TaskKey, number>();

// Cooldown between auto-refetches for a single task's index when a chip
// requests an uuid that is not in the cache. Short enough to pick up a
// sketch that MCP just created, long enough to avoid a fetch storm when a
// message renders several chips for uuids that truly don't exist.
const MISS_REFETCH_COOLDOWN_MS = 1500;

export function taskKey(projectId: string, taskId: string): TaskKey {
  return `${projectId}::${taskId}`;
}

export function getCachedNames(key: TaskKey): Map<string, string> | undefined {
  return sketchNameCache.get(key);
}

export function isInflight(key: TaskKey): boolean {
  return inflight.has(key);
}

function notify(key: TaskKey) {
  const set = subscribers.get(key);
  if (!set) return;
  for (const fn of set) fn();
}

export function subscribe(key: TaskKey, cb: () => void): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

export function loadSketchList(
  projectId: string,
  taskId: string,
): Promise<void> {
  const key = taskKey(projectId, taskId);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = listSketches(projectId, taskId)
    .then((list) => {
      const m = new Map<string, string>();
      for (const s of list) m.set(s.id, s.name);
      sketchNameCache.set(key, m);
    })
    .catch(() => {
      // Cache an empty map so chips render a stable fallback without retry loops.
      sketchNameCache.set(key, new Map());
    })
    .finally(() => {
      inflight.delete(key);
      lastFetchedAt.set(key, Date.now());
      notify(key);
    });
  inflight.set(key, p);
  return p;
}

/** Refetch the sketch index for `(projectId, taskId)` if the last fetch is
 * older than the cooldown. Called by a chip whose uuid isn't in the cache,
 * to pick up sketches the agent created after the initial fetch. */
export function refetchIfStale(projectId: string, taskId: string): void {
  const key = taskKey(projectId, taskId);
  if (inflight.has(key)) return;
  const last = lastFetchedAt.get(key) ?? 0;
  if (Date.now() - last < MISS_REFETCH_COOLDOWN_MS) return;
  void loadSketchList(projectId, taskId);
}

/** Refresh the cached sketch-name list for a task by triggering a new
 * fetch WITHOUT clearing the existing cache first. Chips keep their
 * previously-resolved names visible until the new list lands, avoiding a
 * "briefly Unknown" flash on every agent-triggered list change. Deduped
 * via the inflight map, so rapid repeated calls coalesce. */
export function invalidateSketchNameCache(projectId: string, taskId: string) {
  const key = taskKey(projectId, taskId);
  if (inflight.has(key)) return;
  void loadSketchList(projectId, taskId);
}

/** Populate the cache from an already-fetched list (e.g. the SketchPage's
 * `useSketchList` hook). Avoids a redundant network request and ensures
 * chips re-render against the newest index the moment the page sees it. */
export function setSketchNames(
  projectId: string,
  taskId: string,
  list: Array<{ id: string; name: string }>,
) {
  const key = taskKey(projectId, taskId);
  const m = new Map<string, string>();
  for (const s of list) m.set(s.id, s.name);
  sketchNameCache.set(key, m);
  lastFetchedAt.set(key, Date.now());
  notify(key);
}

export const OPEN_SKETCH_EVENT = "grove:open-sketch";

export interface OpenSketchDetail {
  projectId: string;
  taskId: string;
  sketchId: string;
}
