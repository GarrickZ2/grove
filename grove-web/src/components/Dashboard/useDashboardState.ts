import { useCallback, useEffect, useState } from "react";
import { useAgentCatalogRevision } from "../../hooks/useAgentCatalogRevision";
import { useCommand, useKeyboardScope } from "../../keyboard";
import { useProject } from "../../context";
import {
  getGitStatus,
  getGitBranches,
  getGitCommits,
  gitCheckout,
  gitPull,
  gitPush,
  gitFetch,
  gitCommit,
  createBranch,
  deleteBranch,
  renameBranch,
  openIDE,
  openTerminal,
  archiveTask,
  recoverTask,
  rebaseToTask,
  deleteTask,
  getConfig,
  initGitRepo,
  type RepoStatusResponse,
  type BranchDetailInfo,
  type RepoCommitEntry,
} from "../../api";
import { listMarketplace } from "../../api/marketplace";
import { getProjectStatistics, type StatisticsResponse } from "../../api/statistics";
import type { Branch, Commit, RepoStatus, Task } from "../../data/types";

function convertRepoStatus(status: RepoStatusResponse): RepoStatus {
  return {
    currentBranch: status.current_branch,
    ahead: status.ahead,
    behind: status.behind,
    staged: 0, // backend provides single `uncommitted` count, no staged/untracked breakdown
    unstaged: status.uncommitted, // maps to total uncommitted changes
    untracked: 0, // included in `uncommitted` total
    hasConflicts: status.has_conflicts,
    hasOrigin: status.has_origin,
    hasRemote: status.has_remote,
  };
}

function convertBranch(branch: BranchDetailInfo): Branch {
  return {
    name: branch.name,
    isLocal: branch.is_local,
    isCurrent: branch.is_current,
  };
}

function convertCommit(commit: RepoCommitEntry): Commit {
  return {
    hash: commit.hash,
    message: commit.message,
    author: commit.author,
    timeAgo: commit.time_ago,
  };
}

/**
 * Everything the project Dashboard loads and does, shared by the Workbench
 * page and the Orbit page: repo status / branches / commits, git actions,
 * branch + task dialogs, last-7-days token stats and the environment facts
 * the guidance tips read. `showMessage` feeds the page's toast.
 */
export function useDashboardState() {
  const catalogRevision = useAgentCatalogRevision();
  const { selectedProject, refreshSelectedProject, applySelectedProject } = useProject();
  const isRemote = typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ === true;

  const [showBranchDrawer, setShowBranchDrawer] = useState(false);
  const [showNewBranchDialog, setShowNewBranchDialog] = useState(false);
  const [showRenameBranchDialog, setShowRenameBranchDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);

  const [taskOpTask, setTaskOpTask] = useState<Task | null>(null);
  const [showTaskArchiveDialog, setShowTaskArchiveDialog] = useState(false);
  const [showTaskCleanDialog, setShowTaskCleanDialog] = useState(false);
  const [showTaskRebaseDialog, setShowTaskRebaseDialog] = useState(false);
  const [rebaseAvailableBranches, setRebaseAvailableBranches] = useState<string[]>([]);

  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [repoCommits, setRepoCommits] = useState<Commit[]>([]);
  // Token-centric stats for the Pulse + Activity sections — fetched from the
  // /statistics/project endpoint (last 7 days, daily bucket). Independent
  // of git status, so non-git projects still get token charts.
  const [tokenStats, setTokenStats] = useState<StatisticsResponse | null>(null);
  const [isBranchesLoading, setIsBranchesLoading] = useState(true);
  const [isOperating, setIsOperating] = useState(false);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  // Bumps on every message so a repeated text still re-announces.
  const [messageCount, setMessageCount] = useState(0);

  // Guidance state. `installedAgentCount`: how many marketplace agents
  // are launchable (grove-installed or auto-detected). null = not loaded
  // yet, so we don't flash the "no AI agents installed" tip before the
  // marketplace fetch lands.
  const [installedAgentCount, setInstalledAgentCount] = useState<number | null>(null);
  const [chatAgentConfigured, setChatAgentConfigured] = useState(true);
  // null = unknown until getConfig() resolves — avoids briefly rendering
  // mac-only buttons (Open IDE / Terminal) on Windows/Linux during initial load.
  const [serverPlatform, setServerPlatform] = useState<string | null>(null);

  const loadGitStatus = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const statusRes = await getGitStatus(selectedProject.id);
      setRepoStatus(convertRepoStatus(statusRes));
    } catch (err) {
      console.error("Failed to load git status:", err);
    }
  }, [selectedProject]);

  const loadBranches = useCallback(async () => {
    if (!selectedProject) return;
    setIsBranchesLoading(true);
    try {
      const branchesRes = await getGitBranches(selectedProject.id);
      setBranches(branchesRes.branches.map(convertBranch));
    } catch (err) {
      console.error("Failed to load branches:", err);
    }
    setIsBranchesLoading(false);
  }, [selectedProject]);

  const loadCommits = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const commitsRes = await getGitCommits(selectedProject.id);
      setRepoCommits(commitsRes.commits.map(convertCommit));
    } catch (err) {
      console.error("Failed to load commits:", err);
    }
  }, [selectedProject]);

  const loadTokenStats = useCallback(async () => {
    if (!selectedProject) {
      setTokenStats(null);
      return;
    }
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = now - 7 * 24 * 3600;
      const res = await getProjectStatistics(selectedProject.id, {
        from,
        to: now,
        bucket: "daily",
      });
      setTokenStats(res);
    } catch (err) {
      console.error("Failed to load token stats:", err);
      setTokenStats(null);
    }
  }, [selectedProject]);

  const loadGitData = useCallback(async () => {
    // 非 git 项目:跳过所有 git 调用,避免 500
    if (selectedProject && !selectedProject.isGitRepo) {
      setRepoStatus(null);
      setBranches([]);
      setRepoCommits([]);
      setIsBranchesLoading(false);
      return;
    }
    await Promise.all([loadGitStatus(), loadBranches(), loadCommits()]);
  }, [selectedProject, loadGitStatus, loadBranches, loadCommits]);

  // Token stats run independently of git, so non-git projects still get the
  // Pulse + Activity charts when they've had agent activity. Fetch is an
  // external system call; the loading-state setState inside is intentional.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTokenStats();
  }, [loadTokenStats]);

  useEffect(() => {
    Promise.resolve().then(loadGitData);
  }, [loadGitData]);

  // Check agent availability and config for guidance.
  // Use allSettled so a single failure (e.g. /check-commands transient error)
  // doesn't leave serverPlatform unknown forever and hide the IDE/Terminal buttons.
  useEffect(() => {
    const check = async () => {
      // Marketplace data is the source of truth for "is any agent
      // launchable" — replaces the pre-v2.6 hardcoded PATH probe of
      // claude/codex/gemini.
      const [mktRes, cfgRes] = await Promise.allSettled([
        listMarketplace(),
        getConfig(),
      ]);
      if (mktRes.status === "fulfilled") {
        const count = mktRes.value.agents.filter(
          (a) =>
            a.install_state === "grove-installed" ||
            a.install_state === "auto-detected",
        ).length;
        setInstalledAgentCount(count);
      }
      if (cfgRes.status === "fulfilled") {
        setChatAgentConfigured(!!cfgRes.value.acp?.agent_command);
        setServerPlatform(cfgRes.value.platform);
      }
    };
    check();
  }, [catalogRevision]);

  const showMessage = (message: string) => {
    setOperationMessage(message);
    setMessageCount((count) => count + 1);
    setTimeout(() => setOperationMessage(null), 3000);
  };

  // Initialize git for non-git projects
  const [isInitializingGit, setIsInitializingGit] = useState(false);
  const handleInitGit = async () => {
    if (!selectedProject || isInitializingGit) return;
    setIsInitializingGit(true);
    try {
      // Use the response directly — it already contains the fresh project
      // state (is_git_repo=true, current_branch=main, local_task updated).
      // Going through refreshSelectedProject would fire a second getProject
      // round-trip and leave a render window where selectedProject is updated
      // but repoStatus is still stale from the non-git state.
      const updated = await initGitRepo(selectedProject.id);
      applySelectedProject(updated);
      showMessage("Git repository initialized");
    } catch (err) {
      console.error("Failed to initialize git:", err);
      showMessage("Failed to initialize git repository");
    }
    setIsInitializingGit(false);
  };

  // ── Keyboard scope + branch commands ───────────────────────────────────
  // The catalog scopes git.branch.* under "workspace". The Dashboard and
  // TaskView never mount together (different App routes), so pushing
  // "workspace" here doesn't collide with TaskView's own push.
  useKeyboardScope("workspace");

  const branchOpsEnabled = () =>
    !!selectedProject && selectedProject.isGitRepo && !isOperating;
  const renameBranchEnabled = () =>
    branchOpsEnabled() &&
    (repoStatus?.currentBranch || selectedProject?.currentBranch || "").length > 0;

  useCommand(
    "git.branch.new",
    () => setShowNewBranchDialog(true),
    { enabled: branchOpsEnabled },
    [selectedProject, isOperating],
  );
  useCommand(
    "git.branch.rename",
    () => {
      const currentName =
        repoStatus?.currentBranch || selectedProject?.currentBranch || "";
      if (!currentName) return;
      // Prefer the hydrated Branch entry (carries isLocal/isCurrent), but
      // fall back to a minimal stub so the rename dialog still surfaces
      // before the branches list finishes loading.
      const current =
        branches.find((b) => b.name === currentName) ??
        ({ name: currentName, isLocal: true, isCurrent: true } as Branch);
      setSelectedBranch(current);
      setShowRenameBranchDialog(true);
    },
    { enabled: renameBranchEnabled },
    [branches, selectedProject, repoStatus, isOperating],
  );

  // ── Handlers ──

  const handleOpenTerminal = async () => {
    if (!selectedProject) return;
    try {
      const result = await openTerminal(selectedProject.id);
      showMessage(result.message);
    } catch { showMessage("Failed to open terminal"); }
  };

  const handleOpenIDE = async () => {
    if (!selectedProject) return;
    try {
      const result = await openIDE(selectedProject.id);
      showMessage(result.message);
    } catch { showMessage("Failed to open IDE"); }
  };

  const handlePull = async () => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitPull(selectedProject.id);
      showMessage(result.message);
      if (result.success) await loadGitData();
    } catch { showMessage("Pull failed"); }
    setIsOperating(false);
  };

  const handlePush = async () => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitPush(selectedProject.id);
      showMessage(result.message);
      if (result.success) await loadGitData();
    } catch { showMessage("Push failed"); }
    setIsOperating(false);
  };

  const handleCommit = () => {
    if (!selectedProject || isOperating) return;
    setShowCommitDialog(true);
  };

  const handleCommitSubmit = async (message: string) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitCommit(selectedProject.id, message);
      showMessage(result.message);
      if (result.success) { setShowCommitDialog(false); await loadGitData(); }
    } catch { showMessage("Commit failed"); }
    setIsOperating(false);
  };

  const handleFetch = async () => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitFetch(selectedProject.id);
      showMessage(result.message);
      if (result.success) await loadGitData();
    } catch { showMessage("Fetch failed"); }
    setIsOperating(false);
  };

  const handleCheckout = async (branch: Branch) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitCheckout(selectedProject.id, branch.name);
      showMessage(result.message);
      if (result.success) { await loadGitData(); await refreshSelectedProject(); }
    } catch { showMessage("Checkout failed"); }
    setIsOperating(false);
  };

  const handleNewBranch = () => setShowNewBranchDialog(true);

  const handleCreateBranch = async (name: string, baseBranch: string, checkout: boolean) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await createBranch(selectedProject.id, name, baseBranch, checkout);
      showMessage(result.message);
      if (result.success) { await loadGitData(); if (checkout) await refreshSelectedProject(); }
    } catch { showMessage("Create branch failed"); }
    setIsOperating(false);
    setShowNewBranchDialog(false);
  };

  const handleRenameBranch = (branch: Branch) => { setSelectedBranch(branch); setShowRenameBranchDialog(true); };

  const handleConfirmRename = async (oldName: string, newName: string) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await renameBranch(selectedProject.id, oldName, newName);
      showMessage(result.message);
      if (result.success) await loadGitData();
    } catch { showMessage("Rename failed"); }
    setIsOperating(false);
    setShowRenameBranchDialog(false);
    setSelectedBranch(null);
  };

  const handleDeleteBranch = (branch: Branch) => { setSelectedBranch(branch); setShowDeleteDialog(true); };

  const handleConfirmDelete = async () => {
    if (!selectedProject || !selectedBranch || isOperating) return;
    setIsOperating(true);
    try {
      const result = await deleteBranch(selectedProject.id, selectedBranch.name);
      showMessage(result.message);
      if (result.success) await loadGitData();
    } catch { showMessage("Delete failed"); }
    setIsOperating(false);
    setShowDeleteDialog(false);
    setSelectedBranch(null);
  };

  const handleMergeBranch = (branch: Branch) => { showMessage(`Merge ${branch.name}: not yet implemented`); };
  const handlePullMerge = (branch: Branch) => { showMessage(`Pull merge ${branch.name}: not yet implemented`); };
  const handlePullRebase = (branch: Branch) => { showMessage(`Pull rebase ${branch.name}: not yet implemented`); };

  const handleTaskRebase = async (task: Task) => {
    if (!selectedProject) return;
    setTaskOpTask(task);
    try {
      const branchesRes = await getGitBranches(selectedProject.id);
      setRebaseAvailableBranches(branchesRes.branches.map(b => b.name));
      setShowTaskRebaseDialog(true);
    } catch { showMessage("Failed to load branches"); }
  };

  const handleConfirmTaskRebase = async (newTarget: string) => {
    if (!selectedProject || !taskOpTask || isOperating) return;
    setIsOperating(true);
    let result: Awaited<ReturnType<typeof rebaseToTask>> | null = null;
    let failed = false;
    try {
      result = await rebaseToTask(selectedProject.id, taskOpTask.id, newTarget);
    } catch {
      failed = true;
    }
    if (failed || !result) {
      showMessage("Rebase failed");
    } else {
      const successMsg = result.message || `Rebased onto ${newTarget}`;
      const failMsg = result.message || "Rebase failed";
      showMessage(result.success ? successMsg : failMsg);
      if (result.success) {
        setShowTaskRebaseDialog(false);
        setTaskOpTask(null);
        await refreshSelectedProject();
      }
    }
    setIsOperating(false);
  };

  const handleTaskArchive = (task: Task) => { setTaskOpTask(task); setShowTaskArchiveDialog(true); };
  const handleConfirmTaskArchive = async () => {
    if (!selectedProject || !taskOpTask || isOperating) return;
    setIsOperating(true);
    try { await archiveTask(selectedProject.id, taskOpTask.id); showMessage(`Archived "${taskOpTask.name}"`); await refreshSelectedProject(); }
    catch { showMessage("Archive failed"); }
    setIsOperating(false);
    setShowTaskArchiveDialog(false);
    setTaskOpTask(null);
  };

  const handleTaskClean = (task: Task) => { setTaskOpTask(task); setShowTaskCleanDialog(true); };
  const handleTaskRecover = async (task: Task) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try { await recoverTask(selectedProject.id, task.id); showMessage(`Recovered "${task.name}"`); await refreshSelectedProject(); }
    catch { showMessage("Recover failed"); }
    setIsOperating(false);
  };
  const handleConfirmTaskClean = async () => {
    if (!selectedProject || !taskOpTask || isOperating) return;
    setIsOperating(true);
    try { await deleteTask(selectedProject.id, taskOpTask.id); showMessage(`Cleaned "${taskOpTask.name}"`); await refreshSelectedProject(); }
    catch { showMessage("Clean failed"); }
    setIsOperating(false);
    setShowTaskCleanDialog(false);
    setTaskOpTask(null);
  };

  // ── Derived data ──

  const defaultRepoStatus: RepoStatus = {
    currentBranch: selectedProject?.currentBranch || "main",
    ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0,
    hasConflicts: false, hasOrigin: true, hasRemote: true,
  };
  const currentStatus = repoStatus || defaultRepoStatus;
  const hasLocalChanges = currentStatus.staged + currentStatus.unstaged + currentStatus.untracked > 0;

  return {
    selectedProject,
    isRemote,
    repoStatus,
    currentStatus,
    hasLocalChanges,
    branches,
    repoCommits,
    tokenStats,
    isBranchesLoading,
    isOperating,
    operationMessage,
    messageCount,
    showMessage,
    installedAgentCount,
    chatAgentConfigured,
    serverPlatform,
    isInitializingGit,
    handleInitGit,
    // Dialog state
    showBranchDrawer, setShowBranchDrawer,
    showNewBranchDialog, setShowNewBranchDialog,
    showRenameBranchDialog, setShowRenameBranchDialog,
    showDeleteDialog, setShowDeleteDialog,
    showCommitDialog, setShowCommitDialog,
    selectedBranch, setSelectedBranch,
    taskOpTask, setTaskOpTask,
    showTaskArchiveDialog, setShowTaskArchiveDialog,
    showTaskCleanDialog, setShowTaskCleanDialog,
    showTaskRebaseDialog, setShowTaskRebaseDialog,
    rebaseAvailableBranches,
    // Actions
    handleOpenTerminal,
    handleOpenIDE,
    handlePull,
    handlePush,
    handleCommit,
    handleCommitSubmit,
    handleFetch,
    handleCheckout,
    handleNewBranch,
    handleCreateBranch,
    handleRenameBranch,
    handleConfirmRename,
    handleDeleteBranch,
    handleConfirmDelete,
    handleMergeBranch,
    handlePullMerge,
    handlePullRebase,
    handleTaskRebase,
    handleConfirmTaskRebase,
    handleTaskArchive,
    handleConfirmTaskArchive,
    handleTaskClean,
    handleTaskRecover,
    handleConfirmTaskClean,
  };
}

export type DashboardState = ReturnType<typeof useDashboardState>;
