import { useState, useCallback } from "react";
import {
  commitTask as apiCommitTask,
  mergeTask as apiMergeTask,
  archiveTask as apiArchiveTask,
  syncTask as apiSyncTask,
  rebaseToTask as apiRebaseToTask,
  resetTask as apiResetTask,
  deleteTask as apiDeleteTask,
  getCommits as apiGetCommits,
  getBranches as apiGetBranches,
} from "../api";
import type { ApiError } from "../api/client";
import type { Task } from "../data/types";
import type { PendingArchiveConfirm } from "../utils/archiveHelpers";
import { handleArchiveError, buildArchiveConfirmMessage } from "../utils/archiveHelpers";

/**
 * Configuration for task operations
 */
export interface TaskOperationsConfig {
  /**
   * Project ID for all operations
   */
  projectId: string | null;

  /**
   * Selected task to operate on
   */
  selectedTask: Task | null;

  /**
   * Refresh callback to reload project/tasks data
   */
  onRefresh: () => Promise<void>;

  /**
   * Show message callback
   */
  onShowMessage: (message: string) => void;

  /**
   * Callback when task is archived
   */
  onTaskArchived?: () => void;

  /**
   * Callback when task is merged (to trigger post-merge archive)
   *
   * @param taskId - Task ID that was merged
   * @param taskName - Task name
   */
  onTaskMerged?: (taskId: string, taskName: string) => void;

  /**
   * Set pending archive confirm callback (for 409 errors)
   */
  setPendingArchiveConfirm?: (confirm: PendingArchiveConfirm | null) => void;
}

/**
 * Dirty branch error info for modal display
 */
export interface DirtyBranchError {
  operation: "Sync" | "Merge";
  branch: string;
  isWorktree: boolean;
}

/**
 * Parse backend error message into a structured DirtyBranchError, or null if not a dirty-branch error.
 */
function parseDirtyBranchError(
  message: string,
  operation: "Sync" | "Merge",
  taskBranch: string,
): DirtyBranchError | null {
  if (message.includes("Worktree has uncommitted changes")) {
    return { operation, branch: taskBranch, isWorktree: true };
  }
  // "Target branch 'main' has uncommitted changes" or "Cannot merge: 'main' has uncommitted changes"
  const targetMatch = message.match(/['']([^'']+)[''].*has uncommitted changes/);
  if (targetMatch) {
    return { operation, branch: targetMatch[1], isWorktree: false };
  }
  return null;
}

/**
 * Task operations state
 */
export interface TaskOperationsState {
  // Commit
  showCommitDialog: boolean;
  isCommitting: boolean;
  commitError: string | null;

  // Merge
  showMergeDialog: boolean;
  isMerging: boolean;
  mergeError: string | null;

  // Archive (handled via pendingArchiveConfirm in config)

  // Sync
  isSyncing: boolean;

  // Rebase
  showRebaseDialog: boolean;
  isRebasing: boolean;
  availableBranches: string[];

  // Reset
  showResetConfirm: boolean;
  isResetting: boolean;

  // Clean
  showCleanConfirm: boolean;
  isDeleting: boolean;

  // Dirty branch error
  dirtyBranchError: DirtyBranchError | null;
}

/**
 * Task operations handlers
 */
export interface TaskOperationsHandlers {
  // Commit
  handleCommit: () => void;
  handleCommitSubmit: (message: string) => Promise<void>;
  handleCommitCancel: () => void;

  // Merge
  handleMerge: () => Promise<void>;
  handleMergeSubmit: (method: "squash" | "merge-commit") => Promise<void>;
  handleMergeCancel: () => void;

  // Archive
  handleArchive: () => Promise<void>;
  handleArchiveConfirm: (pendingConfirm: PendingArchiveConfirm | null) => Promise<void>;
  handleArchiveCancel: (pendingConfirm: PendingArchiveConfirm | null) => void;

  // Sync
  handleSync: () => Promise<void>;

  // Rebase
  handleRebase: () => Promise<void>;
  handleRebaseSubmit: (newTarget: string) => Promise<void>;
  handleRebaseCancel: () => void;

  // Reset
  handleReset: () => void;
  handleResetConfirm: () => Promise<void>;
  handleResetCancel: () => void;

  // Clean
  handleClean: () => void;
  handleCleanConfirm: () => Promise<void>;
  handleCleanCancel: () => void;

  // Dirty branch error
  handleDirtyBranchErrorClose: () => void;
}

/**
 * Hook for managing all task operations
 *
 * @param config - Configuration
 * @returns [state, handlers]
 */
export function useTaskOperations(
  config: TaskOperationsConfig
): [TaskOperationsState, TaskOperationsHandlers] {
  const {
    projectId,
    selectedTask,
    onRefresh,
    onShowMessage,
    onTaskArchived,
    onTaskMerged,
    setPendingArchiveConfirm,
  } = config;

  // Commit state
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Merge state
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);

  // Rebase state
  const [showRebaseDialog, setShowRebaseDialog] = useState(false);
  const [isRebasing, setIsRebasing] = useState(false);
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);

  // Reset state
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Clean state
  const [showCleanConfirm, setShowCleanConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Dirty branch error state
  const [dirtyBranchError, setDirtyBranchError] = useState<DirtyBranchError | null>(null);

  // --- Commit handlers ---
  const handleCommit = useCallback(() => {
    setCommitError(null);
    setShowCommitDialog(true);
  }, []);

  const handleCommitSubmit = useCallback(
    async (message: string) => {
      if (!projectId || !selectedTask) return;
      try {
        setIsCommitting(true);
        setCommitError(null);
        const result = await apiCommitTask(projectId, selectedTask.id, message);
        if (result.success) {
          onShowMessage("Changes committed successfully");
          setShowCommitDialog(false);
          await onRefresh();
        } else {
          setCommitError(result.message || "Commit failed");
        }
      } catch (err) {
        console.error("Failed to commit:", err);
        setCommitError("Failed to commit changes");
      } finally {
        setIsCommitting(false);
      }
    },
    [projectId, selectedTask, onRefresh, onShowMessage]
  );

  const handleCommitCancel = useCallback(() => {
    setShowCommitDialog(false);
    setCommitError(null);
  }, []);

  // --- Merge handlers ---
  const handleMerge = useCallback(async () => {
    if (!projectId || !selectedTask || isMerging) return;

    try {
      // Get commit count (TUI: open_merge_dialog)
      const commitsRes = await apiGetCommits(projectId, selectedTask.id);
      const commitCount = commitsRes.total;

      if (commitCount <= 1) {
        // Only 1 commit, merge directly with merge-commit method (TUI logic)
        setIsMerging(true);
        const result = await apiMergeTask(projectId, selectedTask.id, "merge-commit");
        setIsMerging(false);

        if (result.success) {
          onShowMessage(result.message || "Merged successfully");
          await onRefresh();
          // Trigger post-merge archive
          onTaskMerged?.(selectedTask.id, selectedTask.name);
        } else {
          const dirty = parseDirtyBranchError(result.message || "", "Merge", selectedTask.branch);
          if (dirty) {
            setDirtyBranchError(dirty);
          } else {
            onShowMessage(result.message || "Merge failed");
          }
        }
      } else {
        // Multiple commits, show dialog to choose method
        setMergeError(null);
        setShowMergeDialog(true);
      }
    } catch (err) {
      console.error("Failed to get commits:", err);
      // Fallback: show merge dialog
      setMergeError(null);
      setShowMergeDialog(true);
    }
  }, [projectId, selectedTask, isMerging, onRefresh, onShowMessage, onTaskMerged]);

  const handleMergeSubmit = useCallback(
    async (method: "squash" | "merge-commit") => {
      if (!projectId || !selectedTask || isMerging) return;
      try {
        setIsMerging(true);
        setMergeError(null);
        const result = await apiMergeTask(projectId, selectedTask.id, method);
        if (result.success) {
          onShowMessage(result.message || "Merged successfully");
          setShowMergeDialog(false);
          await onRefresh();
          // Trigger post-merge archive
          onTaskMerged?.(selectedTask.id, selectedTask.name);
        } else {
          const dirty = parseDirtyBranchError(result.message || "", "Merge", selectedTask.branch);
          if (dirty) {
            setShowMergeDialog(false);
            setDirtyBranchError(dirty);
          } else {
            setMergeError(result.message || "Merge failed");
          }
        }
      } catch (err) {
        console.error("Failed to merge:", err);
        setMergeError("Failed to merge task");
      } finally {
        setIsMerging(false);
      }
    },
    [projectId, selectedTask, isMerging, onRefresh, onShowMessage, onTaskMerged]
  );

  const handleMergeCancel = useCallback(() => {
    setShowMergeDialog(false);
    setMergeError(null);
  }, []);

  // --- Archive handlers ---
  const handleArchive = useCallback(async () => {
    if (!projectId || !selectedTask) return;
    try {
      await apiArchiveTask(projectId, selectedTask.id);
      await onRefresh();
      onTaskArchived?.();
    } catch (err) {
      if (!setPendingArchiveConfirm) {
        console.error("Failed to archive task:", err);
        onShowMessage("Failed to archive task");
        return;
      }

      const needsConfirm = handleArchiveError(
        err,
        projectId,
        selectedTask.id,
        selectedTask.name,
        "normal",
        buildArchiveConfirmMessage,
        setPendingArchiveConfirm,
        onShowMessage
      );

      if (!needsConfirm) {
        console.error("Failed to archive task:", err);
      }
    }
  }, [projectId, selectedTask, onRefresh, onTaskArchived, setPendingArchiveConfirm, onShowMessage]);

  const handleArchiveConfirm = useCallback(
    async (pendingConfirm: PendingArchiveConfirm | null) => {
      if (!pendingConfirm || !setPendingArchiveConfirm) return;
      try {
        await apiArchiveTask(pendingConfirm.projectId, pendingConfirm.taskId, {
          force: true,
        });
        await onRefresh();
        onShowMessage("Task archived");
        onTaskArchived?.();
      } catch (err) {
        const e = err as ApiError;
        console.error("Failed to archive task:", err);
        onShowMessage(e?.message || "Failed to archive task");
      } finally {
        setPendingArchiveConfirm(null);
      }
    },
    [onRefresh, onShowMessage, onTaskArchived, setPendingArchiveConfirm]
  );

  const handleArchiveCancel = useCallback(
    (_pendingConfirm: PendingArchiveConfirm | null) => {
      if (!setPendingArchiveConfirm) return;
      setPendingArchiveConfirm(null);
      // Note: cleanup is handled by the caller if needed
    },
    [setPendingArchiveConfirm]
  );

  // --- Sync handler ---
  const handleSync = useCallback(async () => {
    if (!projectId || !selectedTask || isSyncing) return;
    try {
      setIsSyncing(true);
      const result = await apiSyncTask(projectId, selectedTask.id);
      if (result.success) {
        onShowMessage(result.message || "Synced successfully");
        await onRefresh();
      } else {
        const dirty = parseDirtyBranchError(result.message || "", "Sync", selectedTask.branch);
        if (dirty) {
          setDirtyBranchError(dirty);
        } else {
          onShowMessage(result.message || "Sync failed");
        }
      }
    } catch (err) {
      console.error("Failed to sync:", err);
      onShowMessage("Failed to sync task");
    } finally {
      setIsSyncing(false);
    }
  }, [projectId, selectedTask, isSyncing, onRefresh, onShowMessage]);

  // --- Rebase handlers ---
  const handleRebase = useCallback(async () => {
    if (!projectId) return;
    try {
      // Fetch available branches
      const branchesRes = await apiGetBranches(projectId);
      setAvailableBranches(branchesRes.branches.map((b) => b.name));
      setShowRebaseDialog(true);
    } catch (err) {
      console.error("Failed to fetch branches:", err);
      onShowMessage("Failed to load branches");
    }
  }, [projectId, onShowMessage]);

  const handleRebaseSubmit = useCallback(
    async (newTarget: string) => {
      if (!projectId || !selectedTask || isRebasing) return;
      try {
        setIsRebasing(true);
        const result = await apiRebaseToTask(projectId, selectedTask.id, newTarget);
        if (result.success) {
          onShowMessage(result.message || "Target branch changed");
          setShowRebaseDialog(false);
          await onRefresh();
        } else {
          onShowMessage(result.message || "Failed to change target branch");
        }
      } catch (err) {
        console.error("Failed to rebase:", err);
        const errorMessage =
          err instanceof Error
            ? err.message
            : (err as { message?: string })?.message || "Failed to change target branch";
        onShowMessage(errorMessage);
      } finally {
        setIsRebasing(false);
      }
    },
    [projectId, selectedTask, isRebasing, onRefresh, onShowMessage]
  );

  const handleRebaseCancel = useCallback(() => {
    setShowRebaseDialog(false);
  }, []);

  // --- Reset handlers ---
  const handleReset = useCallback(() => {
    setShowResetConfirm(true);
  }, []);

  const handleResetConfirm = useCallback(async () => {
    if (!projectId || !selectedTask || isResetting) return;
    try {
      setIsResetting(true);
      const result = await apiResetTask(projectId, selectedTask.id);
      if (result.success) {
        onShowMessage(result.message || "Task reset successfully");
        await onRefresh();
      } else {
        onShowMessage(result.message || "Reset failed");
      }
    } catch (err) {
      console.error("Failed to reset task:", err);
      const errorMessage =
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message || "Failed to reset task";
      onShowMessage(errorMessage);
    } finally {
      setIsResetting(false);
      setShowResetConfirm(false);
    }
  }, [projectId, selectedTask, isResetting, onRefresh, onShowMessage]);

  const handleResetCancel = useCallback(() => {
    setShowResetConfirm(false);
  }, []);

  // --- Clean handlers ---
  const handleClean = useCallback(() => {
    setShowCleanConfirm(true);
  }, []);

  const handleCleanConfirm = useCallback(async () => {
    if (!projectId || !selectedTask || isDeleting) return;
    try {
      setIsDeleting(true);
      await apiDeleteTask(projectId, selectedTask.id);
      await onRefresh();
      onShowMessage("Task deleted successfully");
      onTaskArchived?.();
    } catch (err) {
      console.error("Failed to delete task:", err);
      onShowMessage("Failed to delete task");
    } finally {
      setIsDeleting(false);
      setShowCleanConfirm(false);
    }
  }, [projectId, selectedTask, isDeleting, onRefresh, onShowMessage, onTaskArchived]);

  const handleCleanCancel = useCallback(() => {
    setShowCleanConfirm(false);
  }, []);

  // --- Dirty branch error handler ---
  const handleDirtyBranchErrorClose = useCallback(() => {
    setDirtyBranchError(null);
  }, []);

  const state: TaskOperationsState = {
    showCommitDialog,
    isCommitting,
    commitError,
    showMergeDialog,
    isMerging,
    mergeError,
    isSyncing,
    showRebaseDialog,
    isRebasing,
    availableBranches,
    showResetConfirm,
    isResetting,
    showCleanConfirm,
    isDeleting,
    dirtyBranchError,
  };

  const handlers: TaskOperationsHandlers = {
    handleCommit,
    handleCommitSubmit,
    handleCommitCancel,
    handleMerge,
    handleMergeSubmit,
    handleMergeCancel,
    handleArchive,
    handleArchiveConfirm,
    handleArchiveCancel,
    handleSync,
    handleRebase,
    handleRebaseSubmit,
    handleRebaseCancel,
    handleReset,
    handleResetConfirm,
    handleResetCancel,
    handleClean,
    handleCleanConfirm,
    handleCleanCancel,
    handleDirtyBranchErrorClose,
  };

  return [state, handlers];
}
