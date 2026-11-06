import { useState } from "react";
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
import { useTheme } from "../../context";
import { agentColor } from "../Stats/agentColors";
import { formatTokens, computeDelta } from "../Stats/formatters";
import { getProjectStyle } from "../../utils/projectStyle";
import { shortenPath } from "../../utils/path";
import { useDashboardState } from "./useDashboardState";
import { DashboardDialogs } from "./DashboardDialogs";
import { summarizeWeeklyTokens } from "./weeklyTokens";
import { hasAppDetection } from "../Config/settingsConstants";

interface DashboardPageProps {
  onNavigate: (page: string, data?: Record<string, unknown>) => void;
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
  const dashboard = useDashboardState();
  const {
    selectedProject, isRemote, currentStatus, hasLocalChanges, repoCommits, tokenStats,
    isOperating, operationMessage, installedAgentCount, chatAgentConfigured,
    serverPlatform, isInitializingGit, handleInitGit, setShowBranchDrawer,
    handleOpenIDE, handleOpenTerminal, handleCommit, handlePull, handlePush, handleFetch,
  } = dashboard;
  const { theme } = useTheme();

  const [dismissedTips, setDismissedTips] = useState<Set<string>>(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("grove-dismissed-tips");
    } catch {
      return new Set();
    }
    if (!stored) return new Set();
    try {
      return new Set(JSON.parse(stored));
    } catch {
      return new Set();
    }
  });

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

  const dismissTip = (id: string) => {
    setDismissedTips(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem("grove-dismissed-tips", JSON.stringify([...next]));
      return next;
    });
  };

  // ── Derived data ──

  const { color: projectColor, Icon: ProjectIcon } = getProjectStyle(selectedProject.id, theme.accentPalette);

  // ── Token-centric derived data for Pulse + Activity ──
  const {
    dayLabels,
    series: weeklyTokenSeries,
    total: weeklyTokenTotal,
    peak: weeklyTokenPeak,
    maxValue: weeklyTokenMaxValue,
    peakIdx: weeklyTokenPeakIdx,
    topAgent,
  } = summarizeWeeklyTokens(tokenStats);
  const tokenTrend = computeDelta(
    tokenStats?.current.kpi.tokens_total,
    tokenStats?.previous.kpi.tokens_total,
  );

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
  if (installedAgentCount !== null && installedAgentCount === 0) {
    allTips.push({
      id: "no-agents-installed",
      icon: TerminalSquare,
      title: "No AI agents installed",
      description: "Open the Marketplace from Settings to install a coding agent and unlock AI-powered workflows.",
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
    title: "Explore Extensions",
    description: "Discover Skills, Plugins, and MCP Servers for your Agents.",
    action: { label: "View Extensions", onClick: () => onNavigate("skills") },
    tone: "tip",
  });

  const visibleTips = allTips.filter(t => !dismissedTips.has(t.id));

  // ── Render ──

  return (
    <motion.div
      className="min-h-full lg:h-full flex flex-col gap-4 sm:gap-5 select-none"
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
      <div className={`lg:flex-1 lg:min-h-0 grid grid-cols-1 gap-4 sm:gap-5 items-stretch ${isGitRepo ? "lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]" : ""}`}>

        {/* ── Left column ── */}
        <div className="flex flex-col gap-4 sm:gap-5 lg:min-h-0">

          {/* Hero */}
          <section
            className="flex flex-wrap items-center gap-3 sm:gap-4 rounded-2xl border border-[var(--color-border)] px-4 py-3 sm:px-5 sm:py-4"
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
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-w-0">
                <h1
                  className="text-lg font-semibold tracking-tight text-[var(--color-text)] truncate max-w-[180px] sm:max-w-[260px]"
                  title={selectedProject.name}
                >
                  {selectedProject.name}
                </h1>
                {isStudio ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-highlight)] shrink-0"
                  >
                    <Sparkles className="h-3 w-3" />
                    Studio
                  </span>
                ) : isGitRepo ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/70 px-2 py-0.5 text-xs font-medium shrink-0"
                    style={{ color: "var(--color-highlight)" }}
                  >
                    <GitBranch className="h-3 w-3" />
                    {currentStatus.currentBranch}
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-warning)] shrink-0"
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
              <div className="flex items-center gap-1.5 shrink-0">
                {!isRemote && hasAppDetection(serverPlatform) && (
                  <>
                    <HeroButton icon={Code2} label="Open IDE" onClick={handleOpenIDE} />
                    <HeroButton icon={TerminalSquare} label="Terminal" onClick={handleOpenTerminal} />
                  </>
                )}
                {!isRemote && (serverPlatform === "windows" || serverPlatform === "linux") && (
                  <>
                    <HeroButton
                      icon={Code2}
                      label="Open IDE"
                      onClick={handleOpenIDE}
                      disabled
                      title={`IDE detection is not yet supported on ${serverPlatform === "windows" ? "Windows" : "Linux"}`}
                    />
                    <HeroButton
                      icon={TerminalSquare}
                      label="Terminal"
                      onClick={handleOpenTerminal}
                      disabled
                      title={`Terminal detection is not yet supported on ${serverPlatform === "windows" ? "Windows" : "Linux"}`}
                    />
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

          {/* Pulse — token-centric snapshot for the past 7 days. Numbers
              come from /statistics/project (the same endpoint the
              Statistics page uses) so totals always reconcile with the
              "View Statistics" deep link. */}
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 sm:p-5 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {tokenTrend.direction >= 0 ? (
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
            <div className="mt-3 flex items-baseline gap-2 flex-wrap">
              <span className="text-2xl font-semibold text-[var(--color-text)] tabular-nums">
                {formatTokens(weeklyTokenTotal)}
              </span>
              <span className="text-sm text-[var(--color-text-muted)]">
                tokens this week
              </span>
              {tokenTrend.pct != null && tokenTrend.pct !== 0 && (
                <span
                  className={`text-sm font-medium tabular-nums ${
                    tokenTrend.direction > 0
                      ? "text-[var(--color-success)]"
                      : "text-[var(--color-warning)]"
                  }`}
                >
                  {tokenTrend.pct === Infinity
                    ? "new"
                    : `${tokenTrend.pct > 0 ? "+" : ""}${Math.round(tokenTrend.pct)}%`}
                </span>
              )}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-4">
              <PulseStat
                label="Avg / day"
                value={formatTokens(Math.round(weeklyTokenTotal / 7))}
                subtext="tokens"
              />
              <PulseStat
                label="Peak day"
                value={
                  weeklyTokenPeakIdx >= 0 ? dayLabels[weeklyTokenPeakIdx] : "—"
                }
                subtext={
                  weeklyTokenMaxValue > 0
                    ? `${formatTokens(weeklyTokenMaxValue)} tokens`
                    : "no activity"
                }
              />
              <PulseStat
                label="Top agent"
                value={topAgent || "—"}
                subtext={topAgent ? "by tokens" : "no activity"}
              />
            </div>
          </section>

          {/* Action buttons */}
          <div className={`grid gap-4 shrink-0 ${(isGitRepo && !isStudio) || isStudio ? "grid-cols-2" : "grid-cols-1"}`}>
            {!isStudio && (
              <button
                onClick={() => onNavigate("work")}
                className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 sm:px-5 sm:py-4 text-left transition-colors hover:border-[var(--color-highlight)] group"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]">
                  <Laptop className="h-5 w-5 text-[var(--color-accent)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-[var(--color-text)]">Go to Work</div>
                  <div className="hidden text-xs text-[var(--color-text-muted)] min-[1200px]:block">
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
                className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 sm:px-5 sm:py-4 text-left transition-colors hover:border-[var(--color-highlight)] group"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-info)_12%,transparent)]">
                  <Plus className="h-5 w-5 text-[var(--color-info)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-[var(--color-text)]">New Task</div>
                  <div className="hidden text-xs text-[var(--color-text-muted)] min-[1200px]:block">
                    {isStudio ? "Create AI agent workspace" : "Create isolated worktree"}
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}

            {isStudio && (
              <button
                onClick={() => onNavigate("resource")}
                className="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 sm:px-5 sm:py-4 text-left transition-colors hover:border-[var(--color-highlight)] group"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]">
                  <FolderOpen className="h-5 w-5 text-[var(--color-accent)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-[var(--color-text)]">Manage Resource</div>
                  <div className="hidden text-xs text-[var(--color-text-muted)] min-[1200px]:block">
                    Open the shared resource library
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}
          </div>

          {/* Sessions list — flex-1 fills remaining space */}
          <section className="lg:flex-1 min-h-[120px] rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-[var(--color-border)] shrink-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
                Active Sessions
              </div>
              <span className="text-xs text-[var(--color-text-muted)]">{worktreeTasks.length} task{worktreeTasks.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="lg:flex-1 lg:overflow-y-auto [scrollbar-width:none] hover:[scrollbar-width:thin] [&::-webkit-scrollbar]:w-0 hover:[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--color-border)]">
              {worktreeTasks.length > 0 ? (
                <div className="divide-y divide-[var(--color-border)]">
                  {worktreeTasks.map(task => (
                    <button
                      key={task.id}
                      onClick={() => onNavigate("tasks", { taskId: task.id })}
                      className="flex items-center gap-3 w-full px-4 sm:px-5 py-3 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
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
        <aside className="flex flex-col gap-4 lg:min-h-0">

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
                disabled={
                  !currentStatus.hasRemote ||
                  isOperating ||
                  (currentStatus.hasOrigin && currentStatus.ahead === 0)
                }
              />
              <RepoAction
                icon={ArrowUpDown}
                label="Fetch"
                onClick={handleFetch}
                disabled={!currentStatus.hasOrigin || isOperating}
              />
            </div>
          </div>

          {/* Activity — daily token bars stacked by agent. Same data
              source as Pulse; bar height encodes total tokens, color
              segments encode per-agent contribution. Empty days render
              as a thin baseline so the row stays visually balanced. */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium uppercase tracking-widest text-[var(--color-text-muted)]">
                  Activity
                </div>
                <div className="mt-0.5 text-lg font-semibold text-[var(--color-text)] tabular-nums">
                  {formatTokens(weeklyTokenTotal)} tokens
                </div>
              </div>
              <span className="text-xs text-[var(--color-text-muted)]">
                7 days
              </span>
            </div>
            <div className="mt-4 grid h-28 grid-cols-7 items-end gap-2">
              {weeklyTokenSeries.some((d) => d.total > 0) ? (
                weeklyTokenSeries.map((day, index) => {
                  const heightPct =
                    day.total > 0 ? (day.total / weeklyTokenPeak) * 100 : 0;
                  return (
                    <div
                      key={index}
                      className="flex h-full flex-col justify-end items-center gap-1.5"
                      title={
                        day.total > 0
                          ? `${dayLabels[index]} · ${formatTokens(day.total)} tokens`
                          : `${dayLabels[index]} · no activity`
                      }
                    >
                      <div
                        className="w-full rounded-t-md overflow-hidden flex flex-col-reverse"
                        style={{ height: `${heightPct}%` }}
                      >
                        {day.segments.map((seg) => {
                          const segPct =
                            day.total > 0 ? (seg.tokens / day.total) * 100 : 0;
                          return (
                            <div
                              key={seg.agent}
                              style={{
                                height: `${segPct}%`,
                                backgroundColor: agentColor(seg.agent),
                              }}
                            />
                          );
                        })}
                      </div>
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        {dayLabels[index]}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="col-span-7 flex items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
                  No data
                </div>
              )}
            </div>
          </div>

          {/* Recent Commits — flex-1 fills remaining space */}
          <div className="lg:flex-1 lg:min-h-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 flex flex-col">
            <div className="text-xs font-medium uppercase tracking-widest text-[var(--color-text-muted)] shrink-0">
              Recent Commits
            </div>
            <div className="mt-3 lg:flex-1 lg:overflow-y-auto [scrollbar-width:none] hover:[scrollbar-width:thin] [&::-webkit-scrollbar]:w-0 hover:[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--color-border)] divide-y divide-[var(--color-border)]">
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
      <DashboardDialogs state={dashboard} project={selectedProject} onNavigate={onNavigate} />
    </motion.div>
  );
}

/* ─── Sub-components ─── */

function HeroButton({ icon: Icon, label, onClick, disabled = false, title }: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      className={`inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-sm p-1.5 text-sm font-medium text-[var(--color-text)] transition-colors shrink-0 ${
        disabled
          ? "opacity-50 cursor-not-allowed"
          : "hover:border-[var(--color-highlight)] hover:bg-[var(--color-bg)]"
      }`}
    >
      <Icon className="h-4 w-4" />
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
