import { useCallback, useEffect, useState } from "react";
import { useProject } from "../../../../context/ProjectContext";
import { getDiff, getCommits, type DiffResponse, type CommitsResponse } from "../../../../api";

/** The task branch's diff against its target and its commits (Git panel). */
export function useTaskGit(projectId: string | undefined, taskId: string) {
  const { selectedProject } = useProject();
  const resolvedProjectId = projectId || selectedProject?.id;
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [commitsData, setCommitsData] = useState<CommitsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGitData = useCallback(async () => {
    if (!resolvedProjectId) return;

    try {
      setIsLoading(true);
      setError(null);
      const [diff, commits] = await Promise.all([
        getDiff(resolvedProjectId, taskId),
        getCommits(resolvedProjectId, taskId),
      ]);
      setDiffData(diff);
      setCommitsData(commits);
    } catch (err) {
      console.error("Failed to load git data:", err);
      setError("Failed to load git data. The task may have been deleted or archived.");
    }
    setIsLoading(false);
  }, [resolvedProjectId, taskId]);

  useEffect(() => {
    Promise.resolve().then(loadGitData);
  }, [loadGitData]);

  return { diffData, commitsData, isLoading, error, reload: loadGitData };
}
