import { useEffect, useState } from "react";
import { getShareItems, type ShareItems } from "../../api/shares";

/** The task's share items, loaded once per task. */
export function useShareItems(projectId: string, taskId: string, enabled: boolean): ShareItems | null {
  const [state, setState] = useState<{ key: string; items: ShareItems } | null>(null);
  const key = `${projectId}:${taskId}`;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getShareItems(projectId, taskId)
      .then((items) => { if (!cancelled) setState({ key, items }); })
      .catch(() => { if (!cancelled) setState({ key, items: { reviews: [], designs: [], sketches: [], files: [] } }); });
    return () => { cancelled = true; };
  }, [projectId, taskId, key, enabled]);
  return state?.key === key ? state.items : null;
}
