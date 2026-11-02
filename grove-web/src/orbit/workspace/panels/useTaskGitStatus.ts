import { useCallback, useEffect, useRef, useState } from "react";
import { getTaskGitStatus, type TaskGitStatusResponse } from "../../../api";
import { useProject } from "../../../context/ProjectContext";

/**
 * Ahead/behind and uncommitted changes for the Orbit Git panel. Purely
 * additive: any failure — a 404 from a backend that predates the endpoint,
 * a Studio task, a removed worktree — leaves `status` null and the panel
 * hides those sections, without an error state.
 */
export function useTaskGitStatus(projectIdProp: string | undefined, taskId: string) {
  const { selectedProject } = useProject();
  const projectId = projectIdProp || selectedProject?.id;
  const [status, setStatus] = useState<TaskGitStatusResponse | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    const mine = ++seq.current;
    let next: TaskGitStatusResponse | null = null;
    try {
      const data = await getTaskGitStatus(projectId, taskId);
      next = data && data.is_git ? data : null;
    } catch {
      next = null;
    }
    if (mine === seq.current) setStatus(next);
  }, [projectId, taskId]);

  useEffect(() => {
    Promise.resolve().then(load);
  }, [load]);

  return { status, reload: load };
}
