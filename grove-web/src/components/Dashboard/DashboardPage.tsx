import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { RepoHeader } from "./RepoHeader";
import { ActiveTasksList } from "./ActiveTasksList";
import { QuickStats } from "./QuickStats";
import { GitStatusBar } from "./GitStatusBar";
import { BranchDrawer } from "./BranchDrawer";
import { CommitHistory } from "./CommitHistory";
import { ConfirmDialog, NewBranchDialog, RenameBranchDialog } from "../Dialogs";
import { useProject } from "../../context";
import {
  getGitStatus,
  getGitBranches,
  getGitCommits,
  gitCheckout,
  gitPull,
  gitPush,
  gitFetch,
  createBranch,
  deleteBranch,
  renameBranch,
  getProjectStats,
  openIDE,
  openTerminal,
  type RepoStatusResponse,
  type BranchDetailInfo,
  type RepoCommitEntry,
  type ProjectStatsResponse,
} from "../../api";
import type { Branch, Commit, RepoStatus, Stats } from "../../data/types";

interface DashboardPageProps {
  onNavigate: (page: string, data?: Record<string, unknown>) => void;
}

// Convert API response to frontend types
function convertRepoStatus(status: RepoStatusResponse): RepoStatus {
  return {
    currentBranch: status.current_branch,
    ahead: status.ahead,
    behind: status.behind,
    staged: 0, // API provides total uncommitted count
    unstaged: status.uncommitted,
    untracked: 0,
    hasConflicts: status.has_conflicts,
    hasOrigin: status.has_origin,
  };
}

function convertBranch(branch: BranchDetailInfo): Branch {
  return {
    name: branch.name,
    isLocal: branch.is_local,
    isCurrent: branch.is_current,
    lastCommit: branch.last_commit || undefined,
    aheadBehind:
      branch.ahead !== null && branch.behind !== null
        ? { ahead: branch.ahead, behind: branch.behind }
        : undefined,
  };
}

function convertCommit(commit: RepoCommitEntry): Commit {
  return {
    hash: commit.hash,
    message: commit.message,
    author: commit.author,
    timeAgo: commit.time_ago, // Use pre-formatted time from API
  };
}

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const { selectedProject, refreshSelectedProject } = useProject();

  // Drawer & Dialog states
  const [showBranchDrawer, setShowBranchDrawer] = useState(false);
  const [showNewBranchDialog, setShowNewBranchDialog] = useState(false);
  const [showRenameBranchDialog, setShowRenameBranchDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);

  // Git data states - separate loading for each section
  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [repoCommits, setRepoCommits] = useState<Commit[]>([]);
  const [projectStats, setProjectStats] = useState<ProjectStatsResponse | null>(null);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [isBranchesLoading, setIsBranchesLoading] = useState(true);
  const [isCommitsLoading, setIsCommitsLoading] = useState(true);
  const [isStatsLoading, setIsStatsLoading] = useState(true);
  const [isOperating, setIsOperating] = useState(false);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);

  // Load git status (fast - for header)
  const loadGitStatus = useCallback(async () => {
    if (!selectedProject) return;
    try {
      setIsStatusLoading(true);
      const statusRes = await getGitStatus(selectedProject.id);
      setRepoStatus(convertRepoStatus(statusRes));
    } catch (err) {
      console.error("Failed to load git status:", err);
    } finally {
      setIsStatusLoading(false);
    }
  }, [selectedProject]);

  // Load branches (can be slow)
  const loadBranches = useCallback(async () => {
    if (!selectedProject) return;
    try {
      setIsBranchesLoading(true);
      const branchesRes = await getGitBranches(selectedProject.id);
      setBranches(branchesRes.branches.map(convertBranch));
    } catch (err) {
      console.error("Failed to load branches:", err);
    } finally {
      setIsBranchesLoading(false);
    }
  }, [selectedProject]);

  // Load commits (can be slow)
  const loadCommits = useCallback(async () => {
    if (!selectedProject) return;
    try {
      setIsCommitsLoading(true);
      const commitsRes = await getGitCommits(selectedProject.id);
      setRepoCommits(commitsRes.commits.map(convertCommit));
    } catch (err) {
      console.error("Failed to load commits:", err);
    } finally {
      setIsCommitsLoading(false);
    }
  }, [selectedProject]);

  // Load project stats
  const loadStats = useCallback(async () => {
    if (!selectedProject) return;
    try {
      setIsStatsLoading(true);
      const statsRes = await getProjectStats(selectedProject.id);
      setProjectStats(statsRes);
    } catch (err) {
      console.error("Failed to load stats:", err);
    } finally {
      setIsStatsLoading(false);
    }
  }, [selectedProject]);

  // Load all git data (for refresh after operations)
  const loadGitData = useCallback(async () => {
    await Promise.all([loadGitStatus(), loadBranches(), loadCommits(), loadStats()]);
  }, [loadGitStatus, loadBranches, loadCommits, loadStats]);

  // Initial load - start all requests in parallel but update UI independently
  useEffect(() => {
    loadGitStatus();
    loadBranches();
    loadCommits();
    loadStats();
  }, [loadGitStatus, loadBranches, loadCommits, loadStats]);

  // Show operation message briefly
  const showMessage = (message: string) => {
    setOperationMessage(message);
    setTimeout(() => setOperationMessage(null), 3000);
  };

  // If no project selected, show placeholder
  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--color-text-muted)]">Select a project to view dashboard</p>
      </div>
    );
  }

  // Get tasks for current project (for live tasks list)
  // Only show tasks whose target branch matches the current branch
  const currentBranch = repoStatus?.currentBranch || selectedProject.currentBranch || "main";
  const liveTasks = selectedProject.tasks.filter(
    t => (t.status === "live" || t.status === "idle") && t.target === currentBranch
  );

  // Build project-specific stats from API data or fallback to task list
  const displayStats: Stats = projectStats
    ? {
        totalTasks: projectStats.total_tasks,
        liveTasks: projectStats.live_tasks,
        idleTasks: projectStats.idle_tasks,
        mergedTasks: projectStats.merged_tasks,
        archivedTasks: projectStats.archived_tasks,
        recentActivity: [],
        fileEdits: [],
        weeklyActivity: projectStats.weekly_activity,
      }
    : {
        totalTasks: selectedProject.tasks.length,
        liveTasks: liveTasks.length,
        idleTasks: selectedProject.tasks.filter(t => t.status === "idle").length,
        mergedTasks: selectedProject.tasks.filter(t => t.status === "merged").length,
        archivedTasks: selectedProject.tasks.filter(t => t.status === "archived").length,
        recentActivity: [],
        fileEdits: [],
        weeklyActivity: [],
      };

  // Handlers
  const handleOpenIDE = async () => {
    if (!selectedProject) return;
    try {
      const result = await openIDE(selectedProject.id);
      showMessage(result.message);
    } catch (err) {
      showMessage("Failed to open IDE");
    }
  };

  const handleOpenTerminal = async () => {
    if (!selectedProject) return;
    try {
      const result = await openTerminal(selectedProject.id);
      showMessage(result.message);
    } catch (err) {
      showMessage("Failed to open terminal");
    }
  };

  const handlePull = async () => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitPull(selectedProject.id);
      showMessage(result.message);
      if (result.success) {
        await loadGitData();
      }
    } catch (err) {
      showMessage("Pull failed");
    } finally {
      setIsOperating(false);
    }
  };

  const handlePush = async () => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitPush(selectedProject.id);
      showMessage(result.message);
      if (result.success) {
        await loadGitData();
      }
    } catch (err) {
      showMessage("Push failed");
    } finally {
      setIsOperating(false);
    }
  };

  const handleCommit = () => showMessage("Opening commit dialog...");

  const handleFetch = async () => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitFetch(selectedProject.id);
      showMessage(result.message);
      if (result.success) {
        await loadGitData();
      }
    } catch (err) {
      showMessage("Fetch failed");
    } finally {
      setIsOperating(false);
    }
  };

  const handleCheckout = async (branch: Branch) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitCheckout(selectedProject.id, branch.name);
      showMessage(result.message);
      if (result.success) {
        await loadGitData();
        await refreshSelectedProject();
      }
    } catch (err) {
      showMessage("Checkout failed");
    } finally {
      setIsOperating(false);
    }
  };

  const handleNewBranch = () => {
    setShowNewBranchDialog(true);
  };

  const handleCreateBranch = async (name: string, baseBranch: string, checkout: boolean) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await createBranch(selectedProject.id, name, baseBranch, checkout);
      showMessage(result.message);
      if (result.success) {
        await loadGitData();
        if (checkout) {
          await refreshSelectedProject();
        }
      }
    } catch (err) {
      showMessage("Create branch failed");
    } finally {
      setIsOperating(false);
      setShowNewBranchDialog(false);
    }
  };

  const handleRenameBranch = (branch: Branch) => {
    setSelectedBranch(branch);
    setShowRenameBranchDialog(true);
  };

  const handleConfirmRename = async (oldName: string, newName: string) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await renameBranch(selectedProject.id, oldName, newName);
      showMessage(result.message);
      if (result.success) {
        await loadGitData();
      }
    } catch (err) {
      showMessage("Rename failed");
    } finally {
      setIsOperating(false);
      setShowRenameBranchDialog(false);
      setSelectedBranch(null);
    }
  };

  const handleDeleteBranch = (branch: Branch) => {
    setSelectedBranch(branch);
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async () => {
    if (!selectedProject || !selectedBranch || isOperating) return;
    setIsOperating(true);
    try {
      const result = await deleteBranch(selectedProject.id, selectedBranch.name);
      showMessage(result.message);
      if (result.success) {
        await loadGitData();
      }
    } catch (err) {
      showMessage("Delete failed");
    } finally {
      setIsOperating(false);
      setShowDeleteDialog(false);
      setSelectedBranch(null);
    }
  };

  const handleMergeBranch = (branch: Branch) => {
    showMessage(`Merging ${branch.name} into current branch...`);
  };

  const handlePullMerge = (branch: Branch) => {
    showMessage(`Pulling ${branch.name} into current branch (merge)...`);
    // TODO: Implement git pull --merge from remote branch
  };

  const handlePullRebase = (branch: Branch) => {
    showMessage(`Pulling ${branch.name} into current branch (rebase)...`);
    // TODO: Implement git pull --rebase from remote branch
  };

  // Default repo status for loading state
  const defaultRepoStatus: RepoStatus = {
    currentBranch: selectedProject.currentBranch || "main",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    hasConflicts: false,
    hasOrigin: true, // assume true until loaded
  };

  const currentStatus = repoStatus || defaultRepoStatus;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      {/* Operation Message Toast */}
      {operationMessage && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-lg"
        >
          <span className="text-sm text-[var(--color-text)]">{operationMessage}</span>
        </motion.div>
      )}

      {/* Repository Header with IDE/Terminal buttons */}
      <RepoHeader
        projectId={selectedProject.id}
        name={selectedProject.name}
        path={selectedProject.path}
        onOpenIDE={handleOpenIDE}
        onOpenTerminal={handleOpenTerminal}
      />

      {/* Row 1: Git Status Bar */}
      {isStatusLoading ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-[var(--color-text-muted)] animate-spin" />
        </div>
      ) : (
        <GitStatusBar
          status={currentStatus}
          isOperating={isOperating}
          onSwitchBranch={() => setShowBranchDrawer(true)}
          onPull={handlePull}
          onPush={handlePush}
          onCommit={handleCommit}
          onFetch={handleFetch}
        />
      )}

      {/* Row 2: Active Tasks + Task Stats side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ActiveTasksList
          tasks={liveTasks}
          onTaskClick={(task) => onNavigate("tasks", { taskId: task.id })}
        />
        <QuickStats stats={displayStats} isLoading={isStatsLoading} />
      </div>

      {/* Row 3: Recent Commits */}
      <CommitHistory
        commits={repoCommits}
        getFileChanges={() => []}
        isLoading={isCommitsLoading}
      />

      {/* Branch Drawer (Slide from right) */}
      <BranchDrawer
        isOpen={showBranchDrawer}
        branches={branches}
        tasks={selectedProject.tasks}
        isLoading={isBranchesLoading}
        onClose={() => setShowBranchDrawer(false)}
        onCheckout={handleCheckout}
        onNewBranch={handleNewBranch}
        onRename={handleRenameBranch}
        onDelete={handleDeleteBranch}
        onMerge={handleMergeBranch}
        onPullMerge={handlePullMerge}
        onPullRebase={handlePullRebase}
        onTaskClick={(task) => onNavigate("tasks", { taskId: task.id })}
      />

      {/* Dialogs */}
      <NewBranchDialog
        isOpen={showNewBranchDialog}
        branches={branches}
        currentBranch={currentStatus.currentBranch}
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
