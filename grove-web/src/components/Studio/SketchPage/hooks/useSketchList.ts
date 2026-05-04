import { useCallback, useEffect, useState } from "react";
import {
  listSketches,
  createSketch,
  deleteSketch,
  renameSketch,
  type SketchMeta,
} from "../../../../api";

interface UseSketchListResult {
  sketches: SketchMeta[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<SketchMeta>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
}

export function useSketchList(projectId: string, taskId: string): UseSketchListResult {
  const [sketches, setSketches] = useState<SketchMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listSketches(projectId, taskId);
      setSketches(list);
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
    setLoading(false);
  }, [projectId, taskId]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const create = useCallback(
    async (name: string) => {
      const meta = await createSketch(projectId, taskId, name);
      await refresh();
      return meta;
    },
    [projectId, taskId, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteSketch(projectId, taskId, id);
      await refresh();
    },
    [projectId, taskId, refresh],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      await renameSketch(projectId, taskId, id, name);
      await refresh();
    },
    [projectId, taskId, refresh],
  );

  return { sketches, loading, error, refresh, create, remove, rename };
}
