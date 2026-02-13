import { useState, useCallback } from "react";
import { archiveTask as apiArchiveTask } from "../api";
import type { PendingArchiveConfirm } from "../utils/archiveHelpers";
import { handleArchiveError, buildArchiveConfirmMessage } from "../utils/archiveHelpers";

/**
 * Configuration for post-merge archive
 */
export interface PostMergeArchiveConfig {
  /**
   * Project ID for archive operation (Zen mode: fixed; Blitz mode: from merged task)
   */
  projectId: string | null;

  /**
   * Refresh callback to reload project/tasks data
   */
  onRefresh: () => Promise<void>;

  /**
   * Show message callback
   */
  onShowMessage: (message: string) => void;

  /**
   * Cleanup callback after archive (or skip)
   */
  onCleanup: () => void;

  /**
   * Set pending archive confirm callback (for 409 errors)
   */
  setPendingArchiveConfirm: (confirm: PendingArchiveConfirm | null) => void;
}

/**
 * Post-merge archive state
 */
export interface PostMergeArchiveState {
  showArchiveAfterMerge: boolean;
  mergedTaskId: string | null;
  mergedTaskName: string;
  mergedProjectId: string | null; // Blitz-only (for cross-project operations)
}

/**
 * Post-merge archive handlers
 */
export interface PostMergeArchiveHandlers {
  /**
   * Trigger post-merge archive dialog
   *
   * @param taskId - Task ID that was merged
   * @param taskName - Task name for display
   * @param projectId - Project ID (optional, for Blitz mode)
   */
  triggerPostMergeArchive: (taskId: string, taskName: string, projectId?: string) => void;

  /**
   * Execute archive after merge
   */
  handleArchiveAfterMerge: () => Promise<void>;

  /**
   * Skip archive and cleanup
   */
  handleSkipArchive: () => void;

  /**
   * Cleanup state after archive/skip
   */
  cleanupAfterMerge: () => void;
}

/**
 * Hook for managing post-merge archive workflow
 *
 * @param config - Configuration
 * @returns [state, handlers]
 */
export function usePostMergeArchive(
  config: PostMergeArchiveConfig
): [PostMergeArchiveState, PostMergeArchiveHandlers] {
  const { projectId, onRefresh, onShowMessage, onCleanup, setPendingArchiveConfirm } = config;

  const [showArchiveAfterMerge, setShowArchiveAfterMerge] = useState(false);
  const [mergedTaskId, setMergedTaskId] = useState<string | null>(null);
  const [mergedTaskName, setMergedTaskName] = useState<string>("");
  const [mergedProjectId, setMergedProjectId] = useState<string | null>(null);

  // Trigger post-merge archive dialog
  const triggerPostMergeArchive = useCallback(
    (taskId: string, taskName: string, projectIdOverride?: string) => {
      setMergedTaskId(taskId);
      setMergedTaskName(taskName);
      setMergedProjectId(projectIdOverride || projectId);
      setShowArchiveAfterMerge(true);
    },
    [projectId]
  );

  // Handle archive after merge
  const handleArchiveAfterMerge = useCallback(async () => {
    const targetProjectId = mergedProjectId || projectId;
    if (!targetProjectId || !mergedTaskId) return;

    try {
      await apiArchiveTask(targetProjectId, mergedTaskId);
      await onRefresh();
      onShowMessage("Task archived");
      cleanupAfterMerge();
    } catch (err) {
      const needsConfirm = handleArchiveError(
        err,
        targetProjectId,
        mergedTaskId,
        mergedTaskName,
        "after-merge",
        buildArchiveConfirmMessage,
        setPendingArchiveConfirm,
        onShowMessage
      );

      if (needsConfirm) {
        setShowArchiveAfterMerge(false);
        return;
      }

      console.error("Failed to archive task:", err);
      cleanupAfterMerge();
    }
  }, [
    mergedProjectId,
    projectId,
    mergedTaskId,
    mergedTaskName,
    onRefresh,
    onShowMessage,
    setPendingArchiveConfirm,
  ]);

  // Cleanup after merge
  const cleanupAfterMerge = useCallback(() => {
    setShowArchiveAfterMerge(false);
    setMergedTaskId(null);
    setMergedTaskName("");
    setMergedProjectId(null);
    onCleanup();
  }, [onCleanup]);

  // Skip archive
  const handleSkipArchive = useCallback(() => {
    cleanupAfterMerge();
  }, [cleanupAfterMerge]);

  const state: PostMergeArchiveState = {
    showArchiveAfterMerge,
    mergedTaskId,
    mergedTaskName,
    mergedProjectId,
  };

  const handlers: PostMergeArchiveHandlers = {
    triggerPostMergeArchive,
    handleArchiveAfterMerge,
    handleSkipArchive,
    cleanupAfterMerge,
  };

  return [state, handlers];
}
