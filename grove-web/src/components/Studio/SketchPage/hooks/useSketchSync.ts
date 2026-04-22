import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSketchScene,
  putSketchScene,
  putSketchSceneKeepalive,
  sketchWsUrl,
} from "../../../../api";
import { appendHmacToUrl } from "../../../../api/client";
import { invalidateSketchNameCache } from "../../../ui/sketchChipCache";

interface SketchEvent {
  type: "sketch_updated" | "index_changed";
  project?: string;
  task_id?: string;
  sketch_id?: string;
  source?: "user" | "agent";
  scene?: unknown;
}

interface UseSketchSyncResult {
  scene: unknown | null;
  loading: boolean;
  onLocalChange: (next: unknown) => void;
  remoteTick: number; // increments when an agent-driven update arrives
  /** Force a fresh fetch of the scene from disk and apply it locally (also
   * bumps remoteTick so Excalidraw re-paints). Used by the manual Refresh
   * button — polling + idle-refresh cover most cases but can race with
   * rapid AI writes. */
  refresh: () => Promise<void>;
  /** Realtime WebSocket state. `undefined` = haven't connected yet (initial
   * mount); `true` = open; `false` = disconnected and retrying. UI should
   * render "Reconnecting…" only for `false`, not `undefined`, to avoid
   * flashing during the ~100 ms initial handshake. */
  wsConnected: boolean | undefined;
}

interface LivePreviewOptions {
  /** When true, poll the scene endpoint every POLL_INTERVAL_MS to pick up
   * MCP-authored changes (MCP runs in a separate OS process so its
   * broadcast_sketch_event does not reach this daemon's in-process channel). */
  isChatBusy?: boolean;
  /** Monotonic timestamp bumped when the chat transitions to idle. Triggers
   * one final refresh so the user sees the agent's last write. */
  lastChatIdleAt?: number;
}

const DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 2000;

/** Cheap content fingerprint. We use a hash of just `elements` so polling
 * responses whose content is identical (but reference-new) don't retrigger
 * downstream effects like the thumbnail debounce. Excludes appState which
 * carries transient per-user cursor/zoom state that changes constantly. */
function sceneFingerprint(scene: unknown): string {
  const elements = (scene as { elements?: unknown } | null)?.elements;
  try {
    return JSON.stringify(elements ?? null);
  } catch {
    return "";
  }
}

export function useSketchSync(
  projectId: string,
  taskId: string,
  sketchId: string | null,
  onIndexChanged: () => void,
  live?: LivePreviewOptions,
): UseSketchSyncResult {
  const [scene, setScene] = useState<unknown | null>(null);
  const [loading, setLoading] = useState(true);
  const [remoteTick, setRemoteTick] = useState(0);
  // `undefined` means "haven't attempted connect yet" — consumers render the
  // "Reconnecting…" pill only when this is explicitly `false` (i.e. we DID
  // connect once and then dropped). This avoids a ~50-300 ms flash of the
  // pill during initial mount.
  const [wsConnected, setWsConnected] = useState<boolean | undefined>(undefined);
  const pendingRef = useRef<unknown | null>(null);
  const timerRef = useRef<number | null>(null);
  // Last scene fingerprint we applied. Guards against unnecessary re-renders
  // when a poll / WS event delivers content identical to what we already show.
  const lastFingerprintRef = useRef<string>("");

  /** Apply an incoming scene if its content fingerprint differs from the last
   * applied. Returns true if applied. */
  const applyScene = useCallback((incoming: unknown, bumpRemoteTick: boolean): boolean => {
    const fp = sceneFingerprint(incoming);
    if (fp === lastFingerprintRef.current) return false;
    lastFingerprintRef.current = fp;
    setScene(incoming);
    if (bumpRemoteTick) setRemoteTick((t) => t + 1);
    return true;
  }, []);
  // Snapshot the (projectId, taskId, sketchId) that the pending save belongs to,
  // so the flush still targets the correct sketch after the caller switches tabs.
  const pendingTargetRef = useRef<{ projectId: string; taskId: string; sketchId: string } | null>(null);

  /** Flush a pending debounced save immediately. Returns a promise that
   * resolves when the PUT lands (or resolves instantly when there's nothing
   * to flush) so callers that need to sequence a refetch after the flush can
   * await it. `unload === true` switches to a `keepalive: true` PUT so the
   * request survives page unload (normal fetches get aborted by the browser
   * during unload and the user's last edits are lost). Keepalive bodies are
   * capped at ~64 KB by the browser; on larger scenes we fall back to the
   * regular PUT and accept that it may not complete. */
  const flushPendingSave = useCallback((unload = false): Promise<void> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const payload = pendingRef.current;
    const target = pendingTargetRef.current;
    pendingRef.current = null;
    pendingTargetRef.current = null;
    if (payload == null || !target) return Promise.resolve();
    if (unload) {
      // Best effort: try keepalive first. Browsers reject the Promise
      // (ASYNCHRONOUSLY) when the body exceeds the ~64 KB keepalive cap, so
      // we must chain the fallback inside the promise — a sync try/catch
      // would never see it. The fallback PUT itself may be aborted by the
      // browser during unload but that's the best we can do for a scene
      // that won't fit in keepalive.
      return putSketchSceneKeepalive(
        target.projectId,
        target.taskId,
        target.sketchId,
        payload,
      ).catch(() =>
        putSketchScene(
          target.projectId,
          target.taskId,
          target.sketchId,
          payload,
        ).catch((e) => {
          console.error("sketch flush save (unload) failed", e);
        }),
      );
    }
    return putSketchScene(
      target.projectId,
      target.taskId,
      target.sketchId,
      payload,
    ).catch((e) => {
      console.error("sketch flush save failed", e);
    });
  }, []);

  // Flush when the active sketch (or project/task) changes — pending edits belong
  // to the previous sketch and must not be dropped. Also flushes on final
  // unmount because deps change → cleanup runs.
  useEffect(() => {
    return () => {
      flushPendingSave();
    };
  }, [projectId, taskId, sketchId, flushPendingSave]);

  // Flush on page unload. (The unmount flush is already handled by the effect
  // above; don't call flushPendingSave in this effect's cleanup too or we'd
  // fire twice on unmount.)
  useEffect(() => {
    const onBeforeUnload = () => {
      // keepalive=true so the PUT isn't aborted when the tab closes.
      void flushPendingSave(true);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flushPendingSave]);

  // Keep onIndexChanged in a ref so WS effect doesn't re-open on every parent render.
  const indexChangedRef = useRef(onIndexChanged);
  useEffect(() => {
    indexChangedRef.current = onIndexChanged;
  }, [onIndexChanged]);

  // Keep the active sketchId in a ref for the WS handler without re-creating the socket
  // when switching tabs — we want a single long-lived subscription per (project, task).
  const sketchIdRef = useRef(sketchId);
  useEffect(() => {
    sketchIdRef.current = sketchId;
  }, [sketchId]);

  // Track which sketchId the currently-held `scene` belongs to, so
  // `onLocalChange` can reject onChange callbacks that Excalidraw fires while
  // a stale scene is briefly visible under a new sketchId (would otherwise
  // persist sketch A's elements into sketch B's file on tab switch).
  const loadedSketchIdRef = useRef<string | null>(null);

  // Derived-state reset on sketchId change: wipe `scene` / `loading` in the
  // same render that flips sketchId, so SketchCanvas never mounts with a
  // stale `scene` under a new `activeId` even for a single frame. Doing this
  // in an effect instead would leave one render with the mismatched pair,
  // and Excalidraw's mount-time onChange would persist sketch A's elements
  // into sketch B's file (the reported cross-sketch corruption).
  const [prevSketchId, setPrevSketchId] = useState<string | null>(sketchId);
  if (prevSketchId !== sketchId) {
    setPrevSketchId(sketchId);
    setScene(null);
    setLoading(sketchId != null);
  }

  // Initial load — actually fetches the scene after the reset above. Ref
  // resets live here (render-phase ref writes are forbidden); the guard in
  // onLocalChange doesn't need a synchronous null-reset because the stale
  // ref still holds the previous sketchId, so `ref !== sketchId` naturally
  // rejects mount-time onChange on the newly-rendered canvas.
  useEffect(() => {
    let cancel = false;
    loadedSketchIdRef.current = null;
    lastFingerprintRef.current = "";
    if (!sketchId) return () => {
      cancel = true;
    };
    void getSketchScene(projectId, taskId, sketchId)
      .then((s) => {
        if (cancel) return;
        applyScene(s, false);
        loadedSketchIdRef.current = sketchId;
        setLoading(false);
      })
      .catch((e) => {
        if (!cancel) {
          console.error("sketch load failed", e);
          setLoading(false);
        }
      });
    return () => {
      cancel = true;
    };
  }, [projectId, taskId, sketchId, applyScene]);

  // WebSocket subscription (one per project/task; active sketch is tracked
  // via ref). Reconnects with exponential backoff on drop so a network blip
  // or reverse-proxy idle timeout doesn't permanently starve the UI of
  // real-time updates.
  useEffect(() => {
    // Reset connection state for the new (project, task) pair so the
    // "Reconnecting…" pill doesn't reflect the previous task's state while
    // the new socket handshakes. Deferred via microtask so the effect body
    // doesn't synchronously trigger a cascading render.
    let closed = false;
    queueMicrotask(() => {
      if (!closed) setWsConnected(undefined);
    });
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 30000;

    const connect = async () => {
      if (closed) return;
      const rawUrl = sketchWsUrl(projectId, taskId);
      let url: string;
      try {
        url = await appendHmacToUrl(rawUrl);
      } catch (e) {
        console.error("sketch ws hmac failed", e);
        scheduleReconnect();
        return;
      }
      if (closed) return;
      ws = new WebSocket(url);
      ws.onopen = () => {
        retryDelay = 1000;
        setWsConnected(true);
      };
      ws.onmessage = async (ev) => {
        let data: SketchEvent;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (data.type === "index_changed") {
          indexChangedRef.current();
          // Keep the shared sketch-name cache (used by <SketchChip> anywhere
          // in the app) fresh when another client renames / deletes / creates
          // a sketch. Without this, chips would show stale names until a
          // cache miss re-triggered a fetch.
          invalidateSketchNameCache(projectId, taskId);
        } else if (
          data.type === "sketch_updated" &&
          data.sketch_id === sketchIdRef.current &&
          data.source === "agent"
        ) {
          const activeId = sketchIdRef.current;
          if (!activeId) return;
          if (data.scene !== undefined) {
            applyScene(data.scene, true);
            return;
          }
          try {
            const fresh = await getSketchScene(projectId, taskId, activeId);
            applyScene(fresh, true);
          } catch (e) {
            console.error("sketch refresh failed", e);
          }
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        scheduleReconnect();
      };
      ws.onerror = () => {
        // `onclose` will fire right after — let it handle the reconnect.
      };
    };

    const scheduleReconnect = () => {
      if (closed) return;
      if (retryTimer !== null) return;
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    void connect();

    return () => {
      closed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (ws) {
        // Detach handlers so a close triggered by our cleanup can't queue a
        // reconnect after unmount.
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
    };
  }, [projectId, taskId, applyScene]);

  // Live Preview polling: while the ACP chat is busy, MCP-authored writes
  // land on disk without notifying us (separate OS process → separate
  // in-process broadcast channel). Poll the scene endpoint on a short
  // interval to surface those changes; the fingerprint filter in applyScene
  // keeps identical-content polls from churning downstream effects.
  useEffect(() => {
    if (!live?.isChatBusy || !sketchId) return;
    const capturedSketchId = sketchId;
    const timer = window.setInterval(() => {
      // Skip the poll if the user has an unsaved local edit — applying a
      // server snapshot would clobber their in-flight keystrokes.
      if (pendingRef.current != null) return;
      void getSketchScene(projectId, taskId, capturedSketchId)
        .then((s) => {
          if (sketchIdRef.current !== capturedSketchId) return;
          applyScene(s, true);
        })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [projectId, taskId, sketchId, live?.isChatBusy, applyScene]);

  // One final refresh when the chat transitions to idle, to catch the
  // agent's last write that landed between polls. If the user has a pending
  // debounced save, flush it FIRST (and AWAIT the PUT) so the server sees
  // the user's latest edit before we refetch — otherwise the fetch races the
  // flushed PUT and the UI can visibly "snap to agent's scene, then snap
  // back to the user's edit" as the PUT + broadcast loops back.
  useEffect(() => {
    if (live?.lastChatIdleAt === undefined || !sketchId) return;
    const capturedSketchId = sketchId;
    let cancelled = false;
    void (async () => {
      await flushPendingSave();
      if (cancelled) return;
      try {
        const s = await getSketchScene(projectId, taskId, capturedSketchId);
        if (cancelled || sketchIdRef.current !== capturedSketchId) return;
        applyScene(s, true);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, taskId, sketchId, live?.lastChatIdleAt, applyScene, flushPendingSave]);

  const onLocalChange = useCallback(
    (next: unknown) => {
      if (!sketchId) return;
      // Refuse onChange fired before the current sketch's scene has actually
      // loaded. Without this, a tab switch can land Excalidraw's mount-time
      // onChange (firing with whatever scene was in React state) onto the
      // new sketchId, persisting the previous sketch's elements into this
      // sketch's file.
      if (loadedSketchIdRef.current !== sketchId) return;
      // Excalidraw fires onChange for any state change, including transient
      // appState tweaks (cursor position, selection, hover, zoom). We must
      // gate BOTH the PUT and the thumbnail re-render on an actual element
      // change — otherwise scene.mtime keeps advancing without real edits,
      // and the thumbnail's mtime-based freshness check always loses.
      const fp = sceneFingerprint(next);
      if (fp === lastFingerprintRef.current) return;
      lastFingerprintRef.current = fp;

      pendingRef.current = next;
      pendingTargetRef.current = { projectId, taskId, sketchId };
      // Mirror the edit into React state so downstream effects (notably
      // useSketchThumbnail, which debounces off scene identity) see the change.
      setScene(next);

      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(async () => {
        const payload = pendingRef.current;
        const target = pendingTargetRef.current;
        pendingRef.current = null;
        pendingTargetRef.current = null;
        timerRef.current = null;
        if (payload == null || !target) return;
        try {
          await putSketchScene(target.projectId, target.taskId, target.sketchId, payload);
        } catch (e) {
          console.error("sketch save failed", e);
        }
      }, DEBOUNCE_MS);
    },
    [projectId, taskId, sketchId],
  );

  const refresh = useCallback(async () => {
    if (!sketchId) return;
    // Manual refresh means "I want the server's version" — discard any
    // pending debounced save so it doesn't fire afterward and overwrite the
    // freshly-fetched scene with stale user-side bytes. Without this, Refresh
    // looks like a no-op whenever the user had in-flight edits.
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    pendingTargetRef.current = null;
    // Reset fingerprint so applyScene accepts the fetched scene even if it's
    // identical to what's locally cached (user may want to force-reset the
    // canvas, or we want to clear a stale-looking state).
    lastFingerprintRef.current = "";
    try {
      const fresh = await getSketchScene(projectId, taskId, sketchId);
      if (sketchIdRef.current !== sketchId) return;
      applyScene(fresh, true);
    } catch (e) {
      console.error("sketch refresh failed", e);
    }
  }, [projectId, taskId, sketchId, applyScene]);

  return { scene, loading, onLocalChange, remoteTick, refresh, wsConnected };
}
