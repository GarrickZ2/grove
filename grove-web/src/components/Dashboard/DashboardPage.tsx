import { useState } from "react";
import { motion } from "framer-motion";
import { RepoHeader } from "./RepoHeader";
import { ActiveTasksList } from "./ActiveTasksList";
import { QuickStats } from "./QuickStats";
import { GitStatusBar } from "./GitStatusBar";
import { BranchDrawer } from "./BranchDrawer";
import { CommitHistory } from "./CommitHistory";
import { ConfirmDialog, NewBranchDialog, RenameBranchDialog } from "../Dialogs";
import { useProject } from "../../context";
import {
  mockRepoStatus,
  mockBranches,
  mockStats,
  getCommitFileChanges,
} from "../../data/mockData";
import type { Branch, Commit, Stats } from "../../data/types";

interface DashboardPageProps {
  onNavigate: (page: string, data?: Record<string, unknown>) => void;
}

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const { selectedProject } = useProject();

  // Drawer & Dialog states
  const [showBranchDrawer, setShowBranchDrawer] = useState(false);
  const [showNewBranchDialog, setShowNewBranchDialog] = useState(false);
  const [showRenameBranchDialog, setShowRenameBranchDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);

  // If no project selected, show placeholder
  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--color-text-muted)]">Select a project to view dashboard</p>
      </div>
    );
  }

  // Get tasks for current project
  const liveTasks = selectedProject.tasks.filter(t => t.status === "live");
  const idleTasks = selectedProject.tasks.filter(t => t.status === "idle");
  const mergedTasks = selectedProject.tasks.filter(t => t.status === "merged");
  const archivedTasks = selectedProject.tasks.filter(t => t.status === "archived");

  // Build project-specific stats
  const projectStats: Stats = {
    totalTasks: selectedProject.tasks.length,
    liveTasks: liveTasks.length,
    idleTasks: idleTasks.length,
    mergedTasks: mergedTasks.length,
    archivedTasks: archivedTasks.length,
    recentActivity: mockStats.recentActivity.filter(a => a.projectName === selectedProject.name),
    fileEdits: mockStats.fileEdits,
    weeklyActivity: mockStats.weeklyActivity,
  };

  // Get all commits from all tasks
  const allCommits: Commit[] = selectedProject.tasks
    .flatMap(t => t.commits)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 10);

  // Handlers
  const handleShowToast = (message: string) => {
    console.log("Toast:", message);
  };

  const handleOpenIDE = () => handleShowToast("Opening in IDE...");
  const handleOpenTerminal = () => handleShowToast("Opening Terminal...");
  const handleNewTask = () => handleShowToast("Creating new task...");

  const handlePull = () => handleShowToast("Pulling from origin...");
  const handlePush = () => handleShowToast("Pushing to origin...");
  const handleCommit = () => handleShowToast("Opening commit dialog...");
  const handleStash = () => handleShowToast("Stashing changes...");
  const handleFetch = () => handleShowToast("Fetching from origin...");

  const handleCheckout = (branch: Branch) => {
    handleShowToast(`Checking out ${branch.name}...`);
  };

  const handleNewBranch = () => {
    setShowNewBranchDialog(true);
  };

  const handleCreateBranch = (name: string, baseBranch: string, checkout: boolean) => {
    handleShowToast(`Creating branch ${name} from ${baseBranch}${checkout ? " and checking out" : ""}...`);
    setShowNewBranchDialog(false);
  };

  const handleRenameBranch = (branch: Branch) => {
    setSelectedBranch(branch);
    setShowRenameBranchDialog(true);
  };

  const handleConfirmRename = (oldName: string, newName: string) => {
    handleShowToast(`Renaming ${oldName} to ${newName}...`);
    setShowRenameBranchDialog(false);
    setSelectedBranch(null);
  };

  const handleDeleteBranch = (branch: Branch) => {
    setSelectedBranch(branch);
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = () => {
    if (selectedBranch) {
      handleShowToast(`Deleting branch ${selectedBranch.name}...`);
    }
    setShowDeleteDialog(false);
    setSelectedBranch(null);
  };

  const handleMergeBranch = (branch: Branch) => {
    handleShowToast(`Merging ${branch.name} into current branch...`);
  };

  const handleCreatePR = (branch: Branch) => {
    handleShowToast(`Creating PR for ${branch.name}...`);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      {/* Repository Header with IDE/Terminal/New Task buttons */}
      <RepoHeader
        name={selectedProject.name}
        path={selectedProject.path}
        onOpenIDE={handleOpenIDE}
        onOpenTerminal={handleOpenTerminal}
        onNewTask={handleNewTask}
      />

      {/* Row 1: Git Status Bar */}
      <GitStatusBar
        status={mockRepoStatus}
        onSwitchBranch={() => setShowBranchDrawer(true)}
        onPull={handlePull}
        onPush={handlePush}
        onCommit={handleCommit}
        onStash={handleStash}
        onFetch={handleFetch}
      />

      {/* Row 2: Active Tasks + Task Stats side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ActiveTasksList
          tasks={liveTasks}
          onTaskClick={(task) => onNavigate("tasks", { taskId: task.id })}
        />
        <QuickStats stats={projectStats} />
      </div>

      {/* Row 3: Recent Commits */}
      <CommitHistory
        commits={allCommits}
        getFileChanges={getCommitFileChanges}
        onViewAll={() => onNavigate("commits")}
      />

      {/* Branch Drawer (Slide from right) */}
      <BranchDrawer
        isOpen={showBranchDrawer}
        branches={mockBranches}
        onClose={() => setShowBranchDrawer(false)}
        onCheckout={handleCheckout}
        onNewBranch={handleNewBranch}
        onRename={handleRenameBranch}
        onDelete={handleDeleteBranch}
        onMerge={handleMergeBranch}
        onCreatePR={handleCreatePR}
      />

      {/* Dialogs */}
      <NewBranchDialog
        isOpen={showNewBranchDialog}
        branches={mockBranches}
        currentBranch={mockRepoStatus.currentBranch}
        onClose={() => setShowNewBranchDialog(false)}
        onCreate={handleCreateBranch}
      />

      <RenameBranchDialog
        isOpen={showRenameBranchDialog}
        branchName={selectedBranch?.name || ""}
        onClose={() => {
          setShowRenameBranchDialog(false);
          setSelectedBranch(null);
        }}
        onRename={handleConfirmRename}
      />

      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete Branch"
        message={`Are you sure you want to delete branch "${selectedBranch?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setShowDeleteDialog(false);
          setSelectedBranch(null);
        }}
      />
    </motion.div>
  );
}
