import { useState, useCallback, useEffect, useRef } from "react";
import { listProjects, getProject } from "../../api";
import { useNotifications } from "../../context";
import { convertTaskResponse } from "../../utils/taskConvert";
import type { BlitzTask } from "../../data/types";

export function useBlitzTasks() {
  const [blitzTasks, setBlitzTasks] = useState<BlitzTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { notifications, getTaskNotification } = useNotifications();
  const initializedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    try {
      const { projects } = await listProjects();
      const results = await Promise.all(
        projects.map(async (p) => {
          try {
            const full = await getProject(p.id);
            return full.tasks
              .filter((t) => t.target === full.current_branch && t.status !== "archived")
              .map((t) => ({
                task: convertTaskResponse(t),
                projectId: full.id,
                projectName: full.name,
              }));
          } catch {
            return [];
          }
        })
      );
      setBlitzTasks(results.flat());
    } catch {
      // silently ignore
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Sort with notifications first, then by updatedAt
  const sortedTasks = [...blitzTasks].sort((a, b) => {
    const notifA = getTaskNotification(a.task.id);
    const notifB = getTaskNotification(b.task.id);
    if (notifA && !notifB) return -1;
    if (!notifA && notifB) return 1;
    if (notifA && notifB) {
      const levels: Record<string, number> = { critical: 3, warn: 2, notice: 1 };
      const diff = (levels[notifB.level] ?? 0) - (levels[notifA.level] ?? 0);
      if (diff !== 0) return diff;
    }
    return b.task.updatedAt.getTime() - a.task.updatedAt.getTime();
  });

  // Initial fetch
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Refresh when notifications change (notifications already poll every 5s)
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    fetchAll();
  }, [notifications, fetchAll]);

  return { blitzTasks: sortedTasks, isLoading, refresh: fetchAll };
}
