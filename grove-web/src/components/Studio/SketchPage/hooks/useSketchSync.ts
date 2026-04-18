import { useCallback, useEffect, useRef, useState } from "react";
import { getSketchScene, putSketchScene, sketchWsUrl } from "../../../../api";
import { appendHmacToUrl } from "../../../../api/client";

interface SketchEvent {
  type: "sketch_updated" | "index_changed";
  project?: string;
  task_id?: string;
  sketch_id?: string;
  source?: "user" | "agent";
}

interface UseSketchSyncResult {
  scene: unknown | null;
  loading: boolean;
  onLocalChange: (next: unknown) => void;
  remoteTick: number; // increments when an agent-driven update arrives
}

const DEBOUNCE_MS = 500;

export function useSketchSync(
  projectId: string,
  taskId: string,
  sketchId: string | null,
  onIndexChanged: () => void,
): UseSketchSyncResult {
  const [scene, setScene] = useState<unknown | null>(null);
  const [loading, setLoading] = useState(true);
  const [remoteTick, setRemoteTick] = useState(0);
  const pendingRef = useRef<unknown | null>(null);
  const timerRef = useRef<number | null>(null);

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

  // Initial load
  useEffect(() => {
    let cancel = false;
    if (!sketchId) {
      // Defer state updates so we don't setState synchronously in an effect body.
      const t = window.setTimeout(() => {
        if (cancel) return;
        setScene(null);
        setLoading(false);
      }, 0);
      return () => {
        cancel = true;
        window.clearTimeout(t);
      };
    }
    const t = window.setTimeout(() => {
      if (!cancel) setLoading(true);
    }, 0);
    void getSketchScene(projectId, taskId, sketchId)
      .then((s) => {
        if (!cancel) {
          setScene(s);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancel) {
          console.error("sketch load failed", e);
          setLoading(false);
        }
      });
    return () => {
      cancel = true;
      window.clearTimeout(t);
    };
  }, [projectId, taskId, sketchId]);

  // WebSocket subscription (one per project/task; active sketch is tracked via ref).
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;

    void (async () => {
      const rawUrl = sketchWsUrl(projectId, taskId);
      let url: string;
      try {
        url = await appendHmacToUrl(rawUrl);
      } catch (e) {
        console.error("sketch ws hmac failed", e);
        return;
      }
      if (closed) return;
      ws = new WebSocket(url);
      ws.onmessage = async (ev) => {
        let data: SketchEvent;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (data.type === "index_changed") {
          indexChangedRef.current();
        } else if (
          data.type === "sketch_updated" &&
          data.sketch_id === sketchIdRef.current &&
          data.source === "agent"
        ) {
          const activeId = sketchIdRef.current;
          if (!activeId) return;
          try {
            const fresh = await getSketchScene(projectId, taskId, activeId);
            setScene(fresh);
            setRemoteTick((t) => t + 1);
          } catch (e) {
            console.error("sketch refresh failed", e);
          }
        }
      };
    })();

    return () => {
      closed = true;
      if (ws) ws.close();
    };
  }, [projectId, taskId]);

  const onLocalChange = useCallback(
    (next: unknown) => {
      if (!sketchId) return;
      pendingRef.current = next;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(async () => {
        const payload = pendingRef.current;
        pendingRef.current = null;
        timerRef.current = null;
        if (payload == null) return;
        try {
          await putSketchScene(projectId, taskId, sketchId, payload);
        } catch (e) {
          console.error("sketch save failed", e);
        }
      }, DEBOUNCE_MS);
    },
    [projectId, taskId, sketchId],
  );

  return { scene, loading, onLocalChange, remoteTick };
}
