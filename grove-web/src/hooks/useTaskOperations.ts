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
interface TaskOperationsConfig {
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
  // "Cannot merge: the main repository has uncommitted changes"
  if (message.includes("main repository has uncommitted changes")) {
    return { operation, branch: "", isWorktree: false };
  }
  // Legacy: "Cannot merge: 'main' has uncommitted changes"
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
  handleArchiveCancel: () => void;

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
      setIsCommitting(true);
      setCommitError(null);
      let result: Awaited<ReturnType<typeof apiCommitTask>> | null = null;
      let err: unknown = null;
      try {
        result = await apiCommitTask(projectId, selectedTask.id, message);
      } catch (e) {
        err = e;
      }
      if (err) {
        console.error("Failed to commit:", err);
        setCommitError("Failed to commit changes");
      } else if (result) {
        if (result.success) {
          onShowMessage("Changes committed successfully");
          setShowCommitDialog(false);
          await onRefresh();
        } else {
          const msg = result.message || "Commit failed";
          setCommitError(msg);
        }
      }
      setIsCommitting(false);
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

    let commitsRes: Awaited<ReturnType<typeof apiGetCommits>> | null = null;
    let commitsErr: unknown = null;
    try {
      commitsRes = await apiGetCommits(projectId, selectedTask.id);
    } catch (err) {
      commitsErr = err;
    }

    if (commitsErr || !commitsRes) {
      console.error("Failed to get commits:", commitsErr);
      setMergeError(null);
      setShowMergeDialog(true);
      return;
    }

    const commitCount = commitsRes.total;
    if (commitCount > 1) {
      // Multiple commits, show dialog to choose method
      setMergeError(null);
      setShowMergeDialog(true);
      return;
    }

    // Only 1 commit, merge directly with merge-commit method (TUI logic)
    setIsMerging(true);
    let result: Awaited<ReturnType<typeof apiMergeTask>> | null = null;
    let mergeErr: unknown = null;
    try {
      result = await apiMergeTask(projectId, selectedTask.id, "merge-commit");
    } catch (err) {
      mergeErr = err;
    }
    setIsMerging(false);

    if (mergeErr || !result) {
      console.error("Failed to get commits:", mergeErr);
      setMergeError(null);
      setShowMergeDialog(true);
      return;
    }

    if (result.success) {
      const baseMsg = result.message || "Merged successfully";
      const finalMsg = result.warning ? `${result.message} ⚠️ ${result.warning}` : baseMsg;
      onShowMessage(finalMsg);
      await onRefresh();
      // Trigger post-merge archive
      onTaskMerged?.(selectedTask.id, selectedTask.name);
    } else {
      const errMsg = result.message || "";
      const dirty = parseDirtyBranchError(errMsg, "Merge", selectedTask.branch);
      if (dirty) {
        setDirtyBranchError(dirty);
      } else {
        onShowMessage(errMsg || "Merge failed");
      }
    }
  }, [projectId, selectedTask, isMerging, onRefresh, onShowMessage, onTaskMerged]);

  const handleMergeSubmit = useCallback(
    async (method: "squash" | "merge-commit") => {
      if (!projectId || !selectedTask || isMerging) return;
      setIsMerging(true);
      setMergeError(null);
      let result: Awaited<ReturnType<typeof apiMergeTask>> | null = null;
      let err: unknown = null;
      try {
        result = await apiMergeTask(projectId, selectedTask.id, method);
      } catch (e) {
        err = e;
      }
      if (err) {
        console.error("Failed to merge:", err);
        setMergeError("Failed to merge task");
      } else if (result) {
        if (result.success) {
          const baseMsg = result.message || "Merged successfully";
          const finalMsg = result.warning ? `${result.message} ⚠️ ${result.warning}` : baseMsg;
          onShowMessage(finalMsg);
          setShowMergeDialog(false);
          await onRefresh();
          // Trigger post-merge archive
          onTaskMerged?.(selectedTask.id, selectedTask.name);
        } else {
          const errMsg = result.message || "";
          const dirty = parseDirtyBranchError(errMsg, "Merge", selectedTask.branch);
          if (dirty) {
            setShowMergeDialog(false);
            setDirtyBranchError(dirty);
          } else {
            setMergeError(errMsg || "Merge failed");
          }
        }
      }
      setIsMerging(false);
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
    let err: unknown = null;
    try {
      await apiArchiveTask(projectId, selectedTask.id);
      await onRefresh();
    } catch (e) {
      err = e;
    }
    if (!err) {
      if (onTaskArchived) onTaskArchived();
      return;
    }
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
  }, [projectId, selectedTask, onRefresh, onTaskArchived, setPendingArchiveConfirm, onShowMessage]);

  const handleArchiveConfirm = useCallback(
    async (pendingConfirm: PendingArchiveConfirm | null) => {
      if (!pendingConfirm || !setPendingArchiveConfirm) return;
      let err: unknown = null;
      try {
        await apiArchiveTask(pendingConfirm.projectId, pendingConfirm.taskId, {
          force: true,
        });
        await onRefresh();
      } catch (e) {
        err = e;
      }
      if (err) {
        const apiErr = err as ApiError;
        console.error("Failed to archive task:", err);
        const msg = apiErr?.message || "Failed to archive task";
        onShowMessage(msg);
      } else {
        onShowMessage("Task archived");
        onTaskArchived?.();
      }
      setPendingArchiveConfirm(null);
    },
    [onRefresh, onShowMessage, onTaskArchived, setPendingArchiveConfirm]
  );

  const handleArchiveCancel = useCallback(
    () => {
      if (!setPendingArchiveConfirm) return;
      setPendingArchiveConfirm(null);
      // Note: cleanup is handled by the caller if needed
    },
    [setPendingArchiveConfirm]
  );

  // --- Sync handler ---
  const handleSync = useCallback(async () => {
    if (!projectId || !selectedTask || isSyncing) return;
    setIsSyncing(true);
    let result: Awaited<ReturnType<typeof apiSyncTask>> | null = null;
    let err: unknown = null;
    try {
      result = await apiSyncTask(projectId, selectedTask.id);
    } catch (e) {
      err = e;
    }
    if (err) {
      console.error("Failed to sync:", err);
      onShowMessage("Failed to sync task");
    } else if (result) {
      const msg = result.message || "";
      if (result.success) {
        onShowMessage(msg || "Synced successfully");
        await onRefresh();
      } else {
        const dirty = parseDirtyBranchError(msg, "Sync", selectedTask.branch);
        if (dirty) {
          setDirtyBranchError(dirty);
        } else {
          onShowMessage(msg || "Sync failed");
        }
      }
    }
    setIsSyncing(false);
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
      setIsRebasing(true);
      let result: Awaited<ReturnType<typeof apiRebaseToTask>> | null = null;
      let err: unknown = null;
      try {
        result = await apiRebaseToTask(projectId, selectedTask.id, newTarget);
      } catch (e) {
        err = e;
      }
      if (err) {
        console.error("Failed to rebase:", err);
        let errorMessage: string;
        if (err instanceof Error) {
          errorMessage = err.message;
        } else {
          const fallback = (err as { message?: string })?.message;
          errorMessage = fallback || "Failed to change target branch";
        }
        onShowMessage(errorMessage);
      } else if (result) {
        const msg = result.message || "";
        if (result.success) {
          onShowMessage(msg || "Target branch changed");
          setShowRebaseDialog(false);
          await onRefresh();
        } else {
          onShowMessage(msg || "Failed to change target branch");
        }
      }
      setIsRebasing(false);
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
    setIsResetting(true);
    let result: Awaited<ReturnType<typeof apiResetTask>> | null = null;
    let err: unknown = null;
    try {
      result = await apiResetTask(projectId, selectedTask.id);
    } catch (e) {
      err = e;
    }
    if (err) {
      console.error("Failed to reset task:", err);
      let errorMessage: string;
      if (err instanceof Error) {
        errorMessage = err.message;
      } else {
        const fallback = (err as { message?: string })?.message;
        errorMessage = fallback || "Failed to reset task";
      }
      onShowMessage(errorMessage);
    } else if (result) {
      const msg = result.message || "";
      if (result.success) {
        onShowMessage(msg || "Task reset successfully");
        await onRefresh();
      } else {
        onShowMessage(msg || "Reset failed");
      }
    }
    setIsResetting(false);
    setShowResetConfirm(false);
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
    setIsDeleting(true);
    let err: unknown = null;
    try {
      await apiDeleteTask(projectId, selectedTask.id);
      await onRefresh();
    } catch (e) {
      err = e;
    }
    if (err) {
      console.error("Failed to delete task:", err);
      onShowMessage("Failed to delete task");
    } else {
      onShowMessage("Task deleted successfully");
      if (onTaskArchived) onTaskArchived();
    }
    setIsDeleting(false);
    setShowCleanConfirm(false);
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
