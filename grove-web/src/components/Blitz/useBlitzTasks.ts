import { useState, useCallback, useEffect } from "react";
import { listProjects, getProject } from "../../api";
import { convertTaskResponse } from "../../utils/taskConvert";
import type { BlitzTask, ProjectType } from "../../data/types";

export function useBlitzTasks() {
  const [blitzTasks, setBlitzTasks] = useState<BlitzTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const { projects } = await listProjects();
      const results = await Promise.all(
        projects.map(async (p) => {
          try {
            const full = await getProject(p.id);
            // Worktree tasks + the project's Local Task (Blitz view surfaces both)
            const projectType: ProjectType = full.project_type === "studio" ? "studio" : "repo";
            const worktreeTasks = full.tasks
              .filter((t) => t.status !== "archived")
              .map((t) => ({
                task: convertTaskResponse(t),
                projectId: full.id,
                projectName: full.name,
                projectType,
              }));
            if (full.local_task) {
              worktreeTasks.push({
                task: convertTaskResponse(full.local_task),
                projectId: full.id,
                projectName: full.name,
                projectType,
              });
            }
            return worktreeTasks;
          } catch {
            return [];
          }
        })
      );
      setBlitzTasks(results.flat());
    } catch (err) {
      console.error("[BlitzTasks] fetch failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return { blitzTasks, isLoading, refresh: fetchAll };
}
