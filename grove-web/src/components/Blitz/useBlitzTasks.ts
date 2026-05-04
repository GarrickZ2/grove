import { useState, useCallback, useEffect } from "react";
import { listProjects, getProject } from "../../api";
import { convertTaskResponse } from "../../utils/taskConvert";
import type { BlitzTask, ProjectType } from "../../data/types";

export function useBlitzTasks() {
  const [blitzTasks, setBlitzTasks] = useState<BlitzTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    let projectsList: Awaited<ReturnType<typeof listProjects>>["projects"] | null = null;
    try {
      const res = await listProjects();
      projectsList = res.projects;
    } catch (err) {
      console.error("[BlitzTasks] fetch failed:", err);
    }
    if (!projectsList) {
      setIsLoading(false);
      return;
    }
    const results = await Promise.all(
      projectsList.map(async (p) => {
        let full: Awaited<ReturnType<typeof getProject>> | null = null;
        try {
          full = await getProject(p.id);
        } catch {
          full = null;
        }
        if (!full) return [];
        // Worktree tasks + the project's Local Task (Blitz view surfaces both)
        const projectType: ProjectType = full.project_type === "studio" ? "studio" : "repo";
        const worktreeTasks = full.tasks
          .filter((t) => t.status !== "archived")
          .map((t) => ({
            task: convertTaskResponse(t),
            projectId: full!.id,
            projectName: full!.name,
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
      })
    );
    setBlitzTasks(results.flat());
    setIsLoading(false);
  }, []);

  // Initial fetch — kick off async work; setState happens in .then callbacks
  // (after await), which the React docs sanction as the legitimate
  // "subscribe to external system" effect pattern.
  useEffect(() => {
    Promise.resolve().then(fetchAll);
  }, [fetchAll]);

  return { blitzTasks, isLoading, refresh: fetchAll };
}
