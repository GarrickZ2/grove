import { CommitDialog, ConfirmDialog, DirtyBranchDialog, MergeDialog } from "../Dialogs";
import { RebaseDialog } from "./dialogs";
import type { Task } from "../../data/types";
import type {
  TaskOperationsState,
  TaskOperationsHandlers,
} from "../../hooks/useTaskOperations";
import type {
  PostMergeArchiveState,
  PostMergeArchiveHandlers,
} from "../../hooks/usePostMergeArchive";
import type { PendingArchiveConfirm } from "../../utils/archiveHelpers";

interface TaskOperationDialogsProps {
  /**
   * The task that operations are targeting. Used only for display
   * (names, branches, etc.) inside the dialog messages. Pass the currently
   * selected task or the Local Task for Work mode.
   */
  task: Task | null;
  opsState: TaskOperationsState;
  opsHandlers: TaskOperationsHandlers;
  postMergeState: PostMergeArchiveState;
  postMergeHandlers: PostMergeArchiveHandlers;
  pendingArchiveConfirm: PendingArchiveConfirm | null;
}

/**
 * Bundled dialog set that hosts every modal driven by `useTaskOperations` +
 * `usePostMergeArchive`. Shared between `TasksPage` and `WorkPage` so we have
 * one source of truth for operation dialog wiring.
 *
 * The Clean / Reset dialogs adapt their copy based on whether the task is a
 * Local Task (Work mode) or a worktree task.
 */
export function TaskOperationDialogs({
  task,
  opsState,
  opsHandlers,
  postMergeState,
  postMergeHandlers,
  pendingArchiveConfirm,
}: TaskOperationDialogsProps) {
  const isLocalTask = task?.isLocal ?? false;
  const taskName = task?.name ?? "";
  const taskBranch = task?.branch ?? "";
  const taskTarget = task?.target ?? "";

  const cleanTitle = isLocalTask ? "Clean Working Directory" : "Delete Task";
  const cleanMessage = isLocalTask
    ? `Are you sure you want to clean "${taskName}"? This will discard all uncommitted changes.`
    : `Are you sure you want to delete "${taskName}"? This will remove the worktree and all associated data. This action cannot be undone.`;
  const cleanConfirmLabel = opsState.isDeleting
    ? isLocalTask
      ? "Cleaning..."
      : "Deleting..."
    : isLocalTask
      ? "Clean"
      : "Delete";

  const resetTitle = isLocalTask ? "Reset Work" : "Reset Task";
  const resetMessage = isLocalTask
    ? `Reset "${taskName}" to ${taskTarget}? This will discard all local changes. This action cannot be undone.`
    : `Are you sure you want to reset "${taskName}"? This will discard all changes and recreate the worktree from ${taskTarget}. This action cannot be undone.`;

  return (
    <>
      {/* Commit Dialog */}
      <CommitDialog
        isOpen={opsState.showCommitDialog}
        isLoading={opsState.isCommitting}
        error={opsState.commitError}
        onCommit={opsHandlers.handleCommitSubmit}
        onCancel={opsHandlers.handleCommitCancel}
      />

      {/* Merge Dialog */}
      <MergeDialog
        isOpen={opsState.showMergeDialog}
        taskName={taskName}
        branchName={taskBranch}
        targetBranch={taskTarget}
        isLoading={opsState.isMerging}
        error={opsState.mergeError}
        onMerge={opsHandlers.handleMergeSubmit}
        onCancel={opsHandlers.handleMergeCancel}
      />

      {/* Clean Confirm Dialog */}
      <ConfirmDialog
        isOpen={opsState.showCleanConfirm}
        title={cleanTitle}
        message={cleanMessage}
        confirmLabel={cleanConfirmLabel}
        variant="danger"
        onConfirm={opsHandlers.handleCleanConfirm}
        onCancel={opsHandlers.handleCleanCancel}
      />

      {/* Reset Confirm Dialog */}
      <ConfirmDialog
        isOpen={opsState.showResetConfirm}
        title={resetTitle}
        message={resetMessage}
        confirmLabel={opsState.isResetting ? "Resetting..." : "Reset"}
        variant="danger"
        onConfirm={opsHandlers.handleResetConfirm}
        onCancel={opsHandlers.handleResetCancel}
      />

      {/* Rebase Dialog (Change Target Branch) */}
      <RebaseDialog
        isOpen={opsState.showRebaseDialog}
        taskName={taskName}
        currentTarget={taskTarget}
        availableBranches={opsState.availableBranches}
        onClose={opsHandlers.handleRebaseCancel}
        onRebase={opsHandlers.handleRebaseSubmit}
      />

      {/* Archive Confirm Dialog (API preflight, e.g. unpushed commits) */}
      <ConfirmDialog
        isOpen={!!pendingArchiveConfirm}
        title="Archive"
        message={pendingArchiveConfirm?.message || ""}
        variant="warning"
        onConfirm={() => opsHandlers.handleArchiveConfirm(pendingArchiveConfirm)}
        onCancel={() => opsHandlers.handleArchiveCancel()}
      />

      {/* Post-merge archive dialog (TUI: ConfirmType::MergeSuccess) */}
      <ConfirmDialog
        isOpen={postMergeState.showArchiveAfterMerge}
        title="Merge Complete"
        message={
          <div className="flex flex-col gap-4">
            <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-3">
              <div className="flex justify-between text-sm">
                <span className="text-[var(--color-text-muted)]">Task</span>
                <span className="text-[var(--color-text)] font-medium">
                  {postMergeState.mergedTaskName}
                </span>
              </div>
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">
              Would you like to archive this task?
            </p>
          </div>
        }
        variant="info"
        confirmLabel="Archive"
        cancelLabel="Later"
        onConfirm={postMergeHandlers.handleArchiveAfterMerge}
        onCancel={postMergeHandlers.handleSkipArchive}
      />

      {/* Dirty branch error dialog */}
      <DirtyBranchDialog
        error={opsState.dirtyBranchError}
        onClose={opsHandlers.handleDirtyBranchErrorClose}
      />
    </>
  );
}
