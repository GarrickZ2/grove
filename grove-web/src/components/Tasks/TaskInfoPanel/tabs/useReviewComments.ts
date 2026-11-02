import { useCallback, useEffect, useState } from "react";
import { useProject } from "../../../../context/ProjectContext";
import { getReviewComments, type ReviewCommentEntry } from "../../../../api";

/** A task's Code Review comments and their status counts (Comments panel). */
export function useReviewComments(projectId: string | undefined, taskId: string) {
  const { selectedProject } = useProject();
  const resolvedProjectId = projectId || selectedProject?.id;
  const [comments, setComments] = useState<ReviewCommentEntry[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [outdatedCount, setOutdatedCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  /** Set when the last load failed (Workbench shows the empty state instead). */
  const [error, setError] = useState<string | null>(null);

  const loadComments = useCallback(async () => {
    if (!resolvedProjectId) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await getReviewComments(resolvedProjectId, taskId);
      setComments(response.comments);
      setOpenCount(response.open_count);
      setResolvedCount(response.resolved_count);
      setOutdatedCount(response.outdated_count);
    } catch (err) {
      console.error("Failed to load review comments:", err);
      setComments([]);
      setError(err instanceof Error && err.message ? err.message : "Failed to load review comments");
    }
    setIsLoading(false);
  }, [resolvedProjectId, taskId]);

  useEffect(() => {
    Promise.resolve().then(loadComments);
  }, [loadComments]);

  return { comments, openCount, resolvedCount, outdatedCount, isLoading, error, reload: loadComments };
}
