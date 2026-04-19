import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Code2,
  FolderOpen,
  GitBranch,
  GitCommit,
  Laptop,
  Lightbulb,
  Plus,
  TerminalSquare,
  TrendingUp,
  TrendingDown,
  X,
  Sparkles,
} from "lucide-react";
import { BranchDrawer } from "./BranchDrawer";
import { ConfirmDialog, NewBranchDialog, RenameBranchDialog, CommitDialog } from "../Dialogs";
import { RebaseDialog } from "../Tasks/dialogs";
import { useProject, useTheme } from "../../context";
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
  getProjectStats,
  openIDE,
  openTerminal,
  archiveTask,
  recoverTask,
  rebaseToTask,
  deleteTask,
  checkCommands,
  getConfig,
  listApplications,
  initGitRepo,
  type RepoStatusResponse,
  type BranchDetailInfo,
  type RepoCommitEntry,
  type ProjectStatsResponse,
} from "../../api";
import type { Branch, Commit, RepoStatus, Task } from "../../data/types";
import { getProjectStyle } from "../../utils/projectStyle";
import { shortenPath } from "../../utils/path";

interface DashboardPageProps {
  onNavigate: (page: string, data?: Record<string, unknown>) => void;
}

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
    timeAgo: commit.time_ago,
  };
}

interface GuidanceTip {
  id: string;
  icon: React.ElementType;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  tone: "info" | "warning" | "tip";
}

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const { selectedProject, refreshSelectedProject, applySelectedProject } = useProject();
  const { theme } = useTheme();

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
  const [weeklyCommitCount, setWeeklyCommitCount] = useState(0);
  const [projectStats, setProjectStats] = useState<ProjectStatsResponse | null>(null);
  const [isBranchesLoading, setIsBranchesLoading] = useState(true);
  const [isOperating, setIsOperating] = useState(false);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);

  // Guidance state
  const [agentAvailability, setAgentAvailability] = useState<Record<string, boolean>>({});
  const [terminalAgentConfigured, setTerminalAgentConfigured] = useState(true);
  const [chatAgentConfigured, setChatAgentConfigured] = useState(true);
  const [serverPlatform, setServerPlatform] = useState<string>("macos");
  const [dismissedTips, setDismissedTips] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("grove-dismissed-tips");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

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

  const loadCommits = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const [commitsRes, weeklyRes] = await Promise.all([
        getGitCommits(selectedProject.id),
        getGitCommits(selectedProject.id, { since: "1 week ago", limit: 100 }),
      ]);
      setRepoCommits(commitsRes.commits.map(convertCommit));
      setWeeklyCommitCount(weeklyRes.commits.length);
    } catch (err) {
      console.error("Failed to load commits:", err);
    }
  }, [selectedProject]);

  const loadStats = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const statsRes = await getProjectStats(selectedProject.id);
      setProjectStats(statsRes);
    } catch (err) {
      console.error("Failed to load stats:", err);
    }
  }, [selectedProject]);

  const loadGitData = useCallback(async () => {
    // 非 git 项目:跳过所有 git 调用,避免 500
    if (selectedProject && !selectedProject.isGitRepo) {
      setRepoStatus(null);
      setBranches([]);
      setRepoCommits([]);
      setWeeklyCommitCount(0);
      setProjectStats(null);
      setIsBranchesLoading(false);
      return;
    }
    await Promise.all([loadGitStatus(), loadBranches(), loadCommits(), loadStats()]);
  }, [selectedProject, loadGitStatus, loadBranches, loadCommits, loadStats]);

  useEffect(() => {
    loadGitData();
  }, [loadGitData]);

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
    } finally {
      setIsInitializingGit(false);
    }
  };

  // Check agent availability and config for guidance
  useEffect(() => {
    const check = async () => {
      try {
        const [cmdResults, cfg, appsResult] = await Promise.all([
          checkCommands(["claude", "codex", "gemini"]),
          getConfig(),
          listApplications(),
        ]);
        setAgentAvailability(cmdResults);
        setTerminalAgentConfigured(!!cfg.layout?.agent_command);
        setChatAgentConfigured(!!cfg.acp?.agent_command);
        setServerPlatform(appsResult.platform);
      } catch {
        // silently fail
      }
    };
    check();
  }, []);

  const showMessage = (message: string) => {
    setOperationMessage(message);
    setTimeout(() => setOperationMessage(null), 3000);
  };

  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--color-text-muted)]">Select a project to view dashboard</p>
      </div>
    );
  }

  // Missing project: gated at the App level via a global overlay.
  // If we reach here, selectedProject.exists is guaranteed to be true.

  const isGitRepo = selectedProject.isGitRepo;
  const isStudio = selectedProject.projectType === "studio";
  // `selectedProject.tasks` contains only worktree tasks; Local Task lives on `localTask`.
  const worktreeTasks = selectedProject.tasks.filter(t => t.status !== "archived");
  const hasLocalWork = selectedProject.localTask != null;

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
    finally { setIsOperating(false); }
  };

  const handlePush = async () => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitPush(selectedProject.id);
      showMessage(result.message);
      if (result.success) await loadGitData();
    } catch { showMessage("Push failed"); }
    finally { setIsOperating(false); }
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
    finally { setIsOperating(false); }
  };

  const handleFetch = async () => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitFetch(selectedProject.id);
      showMessage(result.message);
      if (result.success) await loadGitData();
    } catch { showMessage("Fetch failed"); }
    finally { setIsOperating(false); }
  };

  const handleCheckout = async (branch: Branch) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try {
      const result = await gitCheckout(selectedProject.id, branch.name);
      showMessage(result.message);
      if (result.success) { await loadGitData(); await refreshSelectedProject(); }
    } catch { showMessage("Checkout failed"); }
    finally { setIsOperating(false); }
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
    finally { setIsOperating(false); setShowNewBranchDialog(false); }
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
    finally { setIsOperating(false); setShowRenameBranchDialog(false); setSelectedBranch(null); }
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
    finally { setIsOperating(false); setShowDeleteDialog(false); setSelectedBranch(null); }
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
    try {
      const result = await rebaseToTask(selectedProject.id, taskOpTask.id, newTarget);
      showMessage(result.success ? (result.message || `Rebased onto ${newTarget}`) : (result.message || "Rebase failed"));
      if (result.success) { setShowTaskRebaseDialog(false); setTaskOpTask(null); await refreshSelectedProject(); }
    } catch { showMessage("Rebase failed"); }
    finally { setIsOperating(false); }
  };

  const handleTaskArchive = (task: Task) => { setTaskOpTask(task); setShowTaskArchiveDialog(true); };
  const handleConfirmTaskArchive = async () => {
    if (!selectedProject || !taskOpTask || isOperating) return;
    setIsOperating(true);
    try { await archiveTask(selectedProject.id, taskOpTask.id); showMessage(`Archived "${taskOpTask.name}"`); await refreshSelectedProject(); }
    catch { showMessage("Archive failed"); }
    finally { setIsOperating(false); setShowTaskArchiveDialog(false); setTaskOpTask(null); }
  };

  const handleTaskClean = (task: Task) => { setTaskOpTask(task); setShowTaskCleanDialog(true); };
  const handleTaskRecover = async (task: Task) => {
    if (!selectedProject || isOperating) return;
    setIsOperating(true);
    try { await recoverTask(selectedProject.id, task.id); showMessage(`Recovered "${task.name}"`); await refreshSelectedProject(); }
    catch { showMessage("Recover failed"); }
    finally { setIsOperating(false); }
  };
  const handleConfirmTaskClean = async () => {
    if (!selectedProject || !taskOpTask || isOperating) return;
    setIsOperating(true);
    try { await deleteTask(selectedProject.id, taskOpTask.id); showMessage(`Cleaned "${taskOpTask.name}"`); await refreshSelectedProject(); }
    catch { showMessage("Clean failed"); }
    finally { setIsOperating(false); setShowTaskCleanDialog(false); setTaskOpTask(null); }
  };

  const dismissTip = (id: string) => {
    setDismissedTips(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem("grove-dismissed-tips", JSON.stringify([...next]));
      return next;
    });
  };

  // ── Derived data ──

  const defaultRepoStatus: RepoStatus = {
    currentBranch: selectedProject.currentBranch || "main",
    ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0,
    hasConflicts: false, hasOrigin: true,
  };
  const currentStatus = repoStatus || defaultRepoStatus;
  const { color: projectColor, Icon: ProjectIcon } = getProjectStyle(selectedProject.id, theme.accentPalette);
  const hasLocalChanges = currentStatus.staged + currentStatus.unstaged + currentStatus.untracked > 0;
  const weeklyData = projectStats?.weekly_activity?.length
    ? [...projectStats.weekly_activity].reverse()
    : [];
  const weeklyPeak = Math.max(...weeklyData, 1); // sentinel 1 for chart divisor
  const weeklyMaxValue = weeklyData.length > 0 ? Math.max(...weeklyData) : 0; // actual max for Pulse
  const weeklyPeakIdx = weeklyMaxValue > 0 ? weeklyData.indexOf(weeklyMaxValue) : -1;
  const weeklyTotal = (projectStats?.weekly_activity || []).reduce((sum, count) => sum + count, 0);

  // Pulse: compare daily average of first half vs second half for trend
  const firstHalfDays = weeklyData.slice(0, 3);
  const secondHalfDays = weeklyData.slice(3);
  const avgFirst = firstHalfDays.length > 0 ? firstHalfDays.reduce((s, v) => s + v, 0) / firstHalfDays.length : 0;
  const avgSecond = secondHalfDays.length > 0 ? secondHalfDays.reduce((s, v) => s + v, 0) / secondHalfDays.length : 0;
  const trendPct = avgFirst > 0
    ? Math.round(((avgSecond - avgFirst) / avgFirst) * 100)
    : avgSecond > 0 ? 100 : 0;

  const dayLabels = (() => {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const today = new Date().getDay();
    const labels: string[] = [];
    for (let i = 6; i >= 0; i--) {
      labels.push(days[(today - i + 7) % 7]);
    }
    return labels;
  })();

  // Guidance tips
  const allTips: GuidanceTip[] = [];
  if (!isGitRepo && !isStudio) {
    allTips.push({
      id: "not-git-repo",
      icon: GitBranch,
      title: "Not a Git repository",
      description:
        "Work sessions, notes and chat still work here. Initialize Git to unlock Tasks, Review and Commit features.",
      action: {
        label: isInitializingGit ? "Initializing..." : "Initialize Git",
        onClick: handleInitGit,
      },
      tone: "warning",
    });
  }
  if (!terminalAgentConfigured) {
    allTips.push({
      id: "no-terminal-agent",
      icon: TerminalSquare,
      title: "Terminal agent not configured",
      description: "Set up a terminal agent to launch AI sessions from worktrees.",
      action: { label: "Settings", onClick: () => onNavigate("settings") },
      tone: "warning",
    });
  }
  if (!chatAgentConfigured) {
    allTips.push({
      id: "no-chat-agent",
      icon: Lightbulb,
      title: "Chat agent not configured",
      description: "Configure a chat agent to enable AI conversations within tasks.",
      action: { label: "Settings", onClick: () => onNavigate("settings") },
      tone: "warning",
    });
  }
  const hasAnyAgent = Object.values(agentAvailability).some(v => v);
  if (!hasAnyAgent && Object.keys(agentAvailability).length > 0) {
    allTips.push({
      id: "no-agents-installed",
      icon: TerminalSquare,
      title: "No AI agents installed",
      description: "Install Claude Code, Codex, or Gemini CLI to enable AI-powered workflows.",
      tone: "warning",
    });
  }
  if (worktreeTasks.length === 0) {
    allTips.push({
      id: "first-task",
      icon: Plus,
      title: "Create your first task",
      description: isStudio
        ? "Tasks provide isolated workspaces for AI agents to process your files."
        : "Tasks run in isolated worktrees — perfect for parallel AI agent work.",
      action: { label: "New Task", onClick: () => onNavigate("tasks", { openNewTask: true }) },
      tone: "info",
    });
  }
  // Always show some tips
  allTips.push({
    id: "cmd-k",
    icon: Lightbulb,
    title: "Quick navigation",
    description: "Press Cmd+K to open the command palette, Cmd+P to switch projects.",
    tone: "tip",
  });
  allTips.push({
    id: "skills",
    icon: Lightbulb,
    title: "Explore Skills",
    description: "Skills extend agent capabilities with specialized knowledge and workflows.",
    action: { label: "View Skills", onClick: () => onNavigate("skills") },
    tone: "tip",
  });

  const visibleTips = allTips.filter(t => !dismissedTips.has(t.id));

  // ── Render ──

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="h-full flex flex-col gap-5 select-none"
    >
      {/* Toast */}
      <AnimatePresence>
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
      </AnimatePresence>

      {/* ── Two-column layout ── */}
      <div className={`flex-1 min-h-0 grid grid-cols-1 gap-5 items-stretch ${isGitRepo ? "xl:grid-cols-[1fr_340px]" : ""}`}>

        {/* ── Left column ── */}
        <div className="flex flex-col gap-5 min-h-0">

          {/* Hero */}
          <section
            className="flex items-center gap-4 rounded-2xl border border-[var(--color-border)] px-5 py-4"
            style={{
              background: `linear-gradient(135deg, color-mix(in srgb, ${projectColor.fg} 8%, var(--color-bg-secondary)), var(--color-bg-secondary) 48%, color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-secondary)))`,
            }}
          >
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/70"
              style={{ backgroundColor: projectColor.bg }}
            >
              <ProjectIcon className="h-5 w-5" style={{ color: projectColor.fg }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-semibold tracking-tight text-[var(--color-text)]">
                  {selectedProject.name}
                </h1>
                {isStudio ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-highlight)]"
                  >
                    <Sparkles className="h-3 w-3" />
                    Studio
                  </span>
                ) : isGitRepo ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/70 px-2 py-0.5 text-xs font-medium"
                    style={{ color: "var(--color-highlight)" }}
                  >
                    <GitBranch className="h-3 w-3" />
                    {currentStatus.currentBranch}
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-warning)]"
                    title="This project is not a Git repository yet"
                  >
                    <GitBranch className="h-3 w-3" />
                    Not a Git repo
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-sm text-[var(--color-text-muted)] truncate">
                {shortenPath(selectedProject.path)}
              </div>
            </div>
            {!isStudio && (
              <div className="flex items-center gap-2 shrink-0">
                {serverPlatform === "macos" && (
                  <>
                    <HeroButton icon={Code2} label="Open IDE" onClick={handleOpenIDE} />
                    <HeroButton icon={TerminalSquare} label="Terminal" onClick={handleOpenTerminal} />
                  </>
                )}
                {isGitRepo && (
                  <HeroButton icon={ArrowUpDown} label="Branches" onClick={() => setShowBranchDrawer(true)} />
                )}
              </div>
            )}
          </section>

          {/* Guidance — contextual, right after Hero */}
          {visibleTips.length > 0 && (
            <section className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_60%,transparent)] p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)] mb-2.5">
                Getting Started
              </div>
              <div className="space-y-2">
                <AnimatePresence>
                  {visibleTips.map(tip => (
                    <motion.div
                      key={tip.id}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                    >
                      <div className="flex items-start gap-3 py-1">
                        <tip.icon className={`h-4 w-4 mt-0.5 shrink-0 ${
                          tip.tone === "warning" ? "text-[var(--color-warning)]"
                          : tip.tone === "info" ? "text-[var(--color-info)]"
                          : "text-[var(--color-text-muted)]"
                        }`} />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-[var(--color-text)]">{tip.title}</span>
                          <span className="text-sm text-[var(--color-text-muted)]"> — {tip.description}</span>
                          {tip.action && (
                            <button
                              onClick={tip.action.onClick}
                              className="ml-2 inline-flex items-center gap-0.5 text-xs font-medium text-[var(--color-highlight)] hover:underline"
                            >
                              {tip.action.label} <ArrowRight className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        <button
                          onClick={() => dismissTip(tip.id)}
                          className="shrink-0 p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}

          {/* Pulse */}
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {trendPct >= 0 ? (
                  <TrendingUp className="h-4 w-4 text-[var(--color-success)]" />
                ) : (
                  <TrendingDown className="h-4 w-4 text-[var(--color-warning)]" />
                )}
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
                  Pulse
                </span>
              </div>
              <button
                onClick={() => onNavigate("statistics")}
                className="text-xs text-[var(--color-highlight)] hover:underline"
              >
                View Statistics
              </button>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-[var(--color-text)]">
                {weeklyTotal.toLocaleString()}
              </span>
              <span className="text-sm text-[var(--color-text-muted)]">actions this week</span>
              {trendPct !== 0 && (
                <span className={`text-sm font-medium ${trendPct > 0 ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}`}>
                  {trendPct > 0 ? "+" : ""}{trendPct}%
                </span>
              )}
            </div>
            <div className={`mt-4 grid gap-4 ${isStudio ? "grid-cols-2" : "grid-cols-3"}`}>
              {!isStudio && (
                <PulseStat label="Commits" value={weeklyCommitCount} subtext="this week" />
              )}
              <PulseStat label="Avg / day" value={weeklyData.length > 0 ? Math.round(weeklyTotal / 7) : 0} subtext="actions" />
              <PulseStat label="Peak day" value={weeklyPeakIdx >= 0 ? dayLabels[weeklyPeakIdx] : "—"} subtext={weeklyMaxValue > 0 ? `${weeklyMaxValue} actions` : "no activity"} />
            </div>
          </section>

          {/* Action buttons */}
          <div className={`grid gap-4 shrink-0 ${(isGitRepo && !isStudio) || isStudio ? "grid-cols-2" : "grid-cols-1"}`}>
            {!isStudio && (
              <button
                onClick={() => onNavigate("work")}
                className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-5 py-4 text-left transition-colors hover:border-[var(--color-highlight)] group"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]">
                  <Laptop className="h-5 w-5 text-[var(--color-accent)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-[var(--color-text)]">Go to Work</div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {hasLocalWork
                      ? `Main repository${isGitRepo ? ` · ${currentStatus.unstaged} changes` : ""}`
                      : "Main repository"
                    }
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}

            {(isGitRepo || isStudio) && (
              <button
                onClick={() => onNavigate("tasks", { openNewTask: true })}
                className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-5 py-4 text-left transition-colors hover:border-[var(--color-highlight)] group"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-info)_12%,transparent)]">
                  <Plus className="h-5 w-5 text-[var(--color-info)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-[var(--color-text)]">New Task</div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {isStudio ? "Create AI agent workspace" : "Create isolated worktree"}
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}

            {isStudio && (
              <button
                onClick={() => onNavigate("resource")}
                className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-5 py-4 text-left transition-colors hover:border-[var(--color-highlight)] group"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]">
                  <FolderOpen className="h-5 w-5 text-[var(--color-accent)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-[var(--color-text)]">Manage Resource</div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    Open the shared resource library
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}
          </div>

          {/* Sessions list — flex-1 fills remaining space */}
          <section className="flex-1 min-h-[120px] rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)] shrink-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
                Active Sessions
              </div>
              <span className="text-xs text-[var(--color-text-muted)]">{worktreeTasks.length} task{worktreeTasks.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="flex-1 overflow-y-auto [scrollbar-width:none] hover:[scrollbar-width:thin] [&::-webkit-scrollbar]:w-0 hover:[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--color-border)]">
              {worktreeTasks.length > 0 ? (
                <div className="divide-y divide-[var(--color-border)]">
                  {worktreeTasks.map(task => (
                    <button
                      key={task.id}
                      onClick={() => onNavigate("tasks", { taskId: task.id })}
                      className="flex items-center gap-3 w-full px-5 py-3 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    >
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-info)]" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-[var(--color-text)] truncate">{task.name}</div>
                        <div className="text-xs text-[var(--color-text-muted)] font-mono truncate">{task.branch}</div>
                      </div>
                      <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{formatRelativeTime(task.updatedAt)}</span>
                      <SessionBadge createdBy={task.createdBy} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full px-5 py-8 text-sm text-[var(--color-text-muted)]">
                  No active tasks — create one to get started
                </div>
              )}
            </div>
          </section>

        </div>

        {/* ── Right column (git-only) ── */}
        {isGitRepo && (
        <aside className="flex flex-col gap-4 min-h-0">

          {/* Repo Control */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
            <div className="text-xs font-medium uppercase tracking-widest text-[var(--color-text-muted)]">
              Repo Control
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <GitStatTile label="Ahead" value={currentStatus.ahead} />
              <GitStatTile label="Behind" value={currentStatus.behind} />
              <GitStatTile label="Changes" value={currentStatus.unstaged} highlight={currentStatus.unstaged > 0} />
              <GitStatTile label="Conflicts" value={currentStatus.hasConflicts ? 1 : 0} warn={currentStatus.hasConflicts} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <RepoAction
                icon={GitCommit}
                label="Commit"
                onClick={handleCommit}
                disabled={!hasLocalChanges || isOperating}
                primary={hasLocalChanges}
              />
              <RepoAction
                icon={ArrowDown}
                label="Pull"
                onClick={handlePull}
                disabled={!currentStatus.hasOrigin || isOperating}
              />
              <RepoAction
                icon={ArrowUp}
                label="Push"
                onClick={handlePush}
                disabled={!currentStatus.hasOrigin || currentStatus.ahead === 0 || isOperating}
              />
              <RepoAction
                icon={ArrowUpDown}
                label="Fetch"
                onClick={handleFetch}
                disabled={!currentStatus.hasOrigin || isOperating}
              />
            </div>
          </div>

          {/* Activity */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium uppercase tracking-widest text-[var(--color-text-muted)]">
                  Activity
                </div>
                <div className="mt-0.5 text-lg font-semibold text-[var(--color-text)]">
                  {weeklyTotal.toLocaleString()} actions
                </div>
              </div>
              <span className="text-xs text-[var(--color-text-muted)]">7 days</span>
            </div>
            <div className="mt-4 grid h-28 grid-cols-7 items-end gap-2">
              {weeklyData.length > 0 ? (
                weeklyData.map((value, index) => (
                  <div key={`${index}-${value}`} className="flex h-full flex-col justify-end items-center gap-1.5">
                    <div
                      className="w-full rounded-t-md bg-[var(--color-success)]"
                      style={{
                        height: `${(value / weeklyPeak) * 100}%`,
                        opacity: 0.6 + (value / weeklyPeak) * 0.4,
                      }}
                    />
                    <span className="text-[10px] text-[var(--color-text-muted)]">
                      {dayLabels[index]}
                    </span>
                  </div>
                ))
              ) : (
                <div className="col-span-7 flex items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
                  No data
                </div>
              )}
            </div>
          </div>

          {/* Recent Commits — flex-1 fills remaining space */}
          <div className="flex-1 min-h-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 flex flex-col">
            <div className="text-xs font-medium uppercase tracking-widest text-[var(--color-text-muted)] shrink-0">
              Recent Commits
            </div>
            <div className="mt-3 flex-1 overflow-y-auto [scrollbar-width:none] hover:[scrollbar-width:thin] [&::-webkit-scrollbar]:w-0 hover:[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--color-border)] divide-y divide-[var(--color-border)]">
              {repoCommits.length > 0 ? repoCommits.slice(0, 10).map(commit => (
                <div key={commit.hash} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <code className="shrink-0 font-mono text-xs text-[var(--color-highlight)]">
                    {commit.hash.slice(0, 7)}
                  </code>
                  <span className="flex-1 min-w-0 text-sm text-[var(--color-text)] leading-snug line-clamp-2">
                    {commit.message}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--color-text-muted)] whitespace-nowrap">
                    {commit.timeAgo ?? ""}
                  </span>
                </div>
              )) : (
                <p className="py-4 text-center text-sm text-[var(--color-text-muted)]">No commits</p>
              )}
            </div>
          </div>
        </aside>
        )}
      </div>

      {/* ── Drawers & Dialogs ── */}
      <BranchDrawer
        isOpen={showBranchDrawer} branches={branches} tasks={selectedProject.tasks}
        isLoading={isBranchesLoading} projectId={selectedProject.id}
        onClose={() => setShowBranchDrawer(false)} onCheckout={handleCheckout}
        onNewBranch={handleNewBranch} onRename={handleRenameBranch}
        onDelete={handleDeleteBranch} onMerge={handleMergeBranch}
        onPullMerge={handlePullMerge} onPullRebase={handlePullRebase}
        onTaskClick={(task) => onNavigate("tasks", { taskId: task.id })}
        onTaskRebase={handleTaskRebase} onTaskArchive={handleTaskArchive}
        onTaskClean={handleTaskClean} onTaskRecover={handleTaskRecover}
      />
      <NewBranchDialog isOpen={showNewBranchDialog} branches={branches}
        currentBranch={currentStatus.currentBranch}
        onClose={() => setShowNewBranchDialog(false)} onCreate={handleCreateBranch}
      />
      <RenameBranchDialog isOpen={showRenameBranchDialog} branchName={selectedBranch?.name || ""}
        onClose={() => { setShowRenameBranchDialog(false); setSelectedBranch(null); }}
        onRename={handleConfirmRename}
      />
      <ConfirmDialog isOpen={showDeleteDialog} title="Delete Branch"
        message={`Are you sure you want to delete branch "${selectedBranch?.name}"? This action cannot be undone.`}
        confirmLabel="Delete" variant="danger" onConfirm={handleConfirmDelete}
        onCancel={() => { setShowDeleteDialog(false); setSelectedBranch(null); }}
      />
      <CommitDialog isOpen={showCommitDialog} isLoading={isOperating}
        onCommit={handleCommitSubmit} onCancel={() => setShowCommitDialog(false)}
      />
      <RebaseDialog isOpen={showTaskRebaseDialog} taskName={taskOpTask?.name}
        currentTarget={taskOpTask?.target || ""} availableBranches={rebaseAvailableBranches}
        onClose={() => { setShowTaskRebaseDialog(false); setTaskOpTask(null); }}
        onRebase={handleConfirmTaskRebase}
      />
      <ConfirmDialog isOpen={showTaskArchiveDialog} title="Archive Task"
        message={`Archive "${taskOpTask?.name}"? The worktree and session will be removed.`}
        confirmLabel="Archive" variant="warning" onConfirm={handleConfirmTaskArchive}
        onCancel={() => { setShowTaskArchiveDialog(false); setTaskOpTask(null); }}
      />
      <ConfirmDialog isOpen={showTaskCleanDialog} title="Clean Task"
        message={`Delete "${taskOpTask?.name}"? This will permanently remove the worktree and all uncommitted changes.`}
        confirmLabel="Delete" variant="danger" onConfirm={handleConfirmTaskClean}
        onCancel={() => { setShowTaskCleanDialog(false); setTaskOpTask(null); }}
      />
    </motion.div>
  );
}

/* ─── Sub-components ─── */

function HeroButton({ icon: Icon, label, onClick }: { icon: React.ElementType; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-sm px-3 py-2 text-sm font-medium text-[var(--color-text)] transition-colors hover:border-[var(--color-highlight)] hover:bg-[var(--color-bg)]"
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}

function SessionBadge({ createdBy }: { createdBy?: string }) {
  const label = createdBy === "agent" ? "agent" : "task";
  const color = createdBy === "agent" ? "var(--color-success)" : "var(--color-info)";
  return (
    <span
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {label}
    </span>
  );
}

function PulseStat({ label, value, subtext }: { label: string; value: string | number; subtext: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-[var(--color-text)]">{value}</div>
      <div className="text-xs text-[var(--color-text-muted)]">{subtext}</div>
    </div>
  );
}

function GitStatTile({ label, value, highlight = false, warn = false }: { label: string; value: number; highlight?: boolean; warn?: boolean }) {
  const valueColor = warn ? "text-[var(--color-error)]" : highlight ? "text-[var(--color-success)]" : "text-[var(--color-text)]";
  return (
    <div className="rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
      <div className={`mt-0.5 text-xl font-semibold ${valueColor}`}>{value}</div>
    </div>
  );
}

function RepoAction({ icon: Icon, label, onClick, disabled = false, primary = false }: {
  icon: React.ElementType; label: string; onClick: () => void; disabled?: boolean; primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
        primary
          ? "border-[var(--color-highlight)] bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] text-[var(--color-text)] hover:bg-[color-mix(in_srgb,var(--color-highlight)_18%,transparent)]"
          : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:border-[var(--color-highlight)]"
      } ${disabled ? "opacity-35 cursor-not-allowed" : ""}`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

