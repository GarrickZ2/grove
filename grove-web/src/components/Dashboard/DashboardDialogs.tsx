import { BranchDrawer } from "./BranchDrawer";
import { ConfirmDialog, NewBranchDialog, RenameBranchDialog, CommitDialog } from "../Dialogs";
import { RebaseDialog } from "../Tasks/dialogs";
import type { DashboardState } from "./useDashboardState";
import type { Project } from "../../data/types";

interface DashboardDialogsProps {
  state: DashboardState;
  project: Project;
  onNavigate: (page: string, data?: Record<string, unknown>) => void;
}

/** Branch drawer + branch / commit / task dialogs driven by `useDashboardState`. */
export function DashboardDialogs({ state, project, onNavigate }: DashboardDialogsProps) {
  const {
    showBranchDrawer, setShowBranchDrawer, branches, isBranchesLoading, currentStatus, isOperating,
    showNewBranchDialog, setShowNewBranchDialog, showRenameBranchDialog, setShowRenameBranchDialog,
    showDeleteDialog, setShowDeleteDialog, showCommitDialog, setShowCommitDialog,
    selectedBranch, setSelectedBranch, taskOpTask, setTaskOpTask,
    showTaskArchiveDialog, setShowTaskArchiveDialog, showTaskCleanDialog, setShowTaskCleanDialog,
    showTaskRebaseDialog, setShowTaskRebaseDialog, rebaseAvailableBranches,
  } = state;
  return (
    <>
      <BranchDrawer
        isOpen={showBranchDrawer} branches={branches} tasks={project.tasks}
        isLoading={isBranchesLoading} projectId={project.id}
        onClose={() => setShowBranchDrawer(false)} onCheckout={state.handleCheckout}
        onNewBranch={state.handleNewBranch} onRename={state.handleRenameBranch}
        onDelete={state.handleDeleteBranch} onMerge={state.handleMergeBranch}
        onPullMerge={state.handlePullMerge} onPullRebase={state.handlePullRebase}
        onTaskClick={(task) => onNavigate("tasks", { taskId: task.id })}
        onTaskRebase={state.handleTaskRebase} onTaskArchive={state.handleTaskArchive}
        onTaskClean={state.handleTaskClean} onTaskRecover={state.handleTaskRecover}
      />
      <NewBranchDialog isOpen={showNewBranchDialog} branches={branches}
        currentBranch={currentStatus.currentBranch}
        onClose={() => setShowNewBranchDialog(false)} onCreate={state.handleCreateBranch}
      />
      <RenameBranchDialog isOpen={showRenameBranchDialog} branchName={selectedBranch?.name || ""}
        onClose={() => { setShowRenameBranchDialog(false); setSelectedBranch(null); }}
        onRename={state.handleConfirmRename}
      />
      <ConfirmDialog isOpen={showDeleteDialog} title="Delete Branch"
        message={`Are you sure you want to delete branch "${selectedBranch?.name}"? This action cannot be undone.`}
        confirmLabel="Delete" variant="danger" onConfirm={state.handleConfirmDelete}
        onCancel={() => { setShowDeleteDialog(false); setSelectedBranch(null); }}
      />
      <CommitDialog isOpen={showCommitDialog} isLoading={isOperating}
        onCommit={state.handleCommitSubmit} onCancel={() => setShowCommitDialog(false)}
      />
      <RebaseDialog isOpen={showTaskRebaseDialog} taskName={taskOpTask?.name}
        currentTarget={taskOpTask?.target || ""} availableBranches={rebaseAvailableBranches}
        onClose={() => { setShowTaskRebaseDialog(false); setTaskOpTask(null); }}
        onRebase={state.handleConfirmTaskRebase}
      />
      <ConfirmDialog isOpen={showTaskArchiveDialog} title="Archive Task"
        message={`Archive "${taskOpTask?.name}"? The worktree and session will be removed.`}
        confirmLabel="Archive" variant="warning" onConfirm={state.handleConfirmTaskArchive}
        onCancel={() => { setShowTaskArchiveDialog(false); setTaskOpTask(null); }}
      />
      <ConfirmDialog isOpen={showTaskCleanDialog} title="Clean Task"
        message={`Delete "${taskOpTask?.name}"? This will permanently remove the worktree and all uncommitted changes.`}
        confirmLabel="Delete" variant="danger" onConfirm={state.handleConfirmTaskClean}
        onCancel={() => { setShowTaskCleanDialog(false); setTaskOpTask(null); }}
      />
    </>
  );
}
