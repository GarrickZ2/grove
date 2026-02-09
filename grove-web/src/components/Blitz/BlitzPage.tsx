import { useState, useMemo, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Terminal, GitCommit, GitBranchPlus, RefreshCw, GitMerge, Archive, RotateCcw, Trash2, Search } from "lucide-react";
import { TaskInfoPanel } from "../Tasks/TaskInfoPanel";
import type { TabType } from "../Tasks/TaskInfoPanel";
import { TaskView } from "../Tasks/TaskView";
import { CommitDialog, ConfirmDialog, MergeDialog } from "../Dialogs";
import { RebaseDialog } from "../Tasks/dialogs";
import { HelpOverlay } from "../Tasks/HelpOverlay";
import { ContextMenu } from "../ui/ContextMenu";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { LogoBrand } from "../Layout/LogoBrand";
import { useNotifications } from "../../context";
import { useHotkeys } from "../../hooks";
import { useBlitzTasks } from "./useBlitzTasks";
import { BlitzTaskListItem } from "./BlitzTaskListItem";
import {
  archiveTask as apiArchiveTask,
  deleteTask as apiDeleteTask,
  syncTask as apiSyncTask,
  commitTask as apiCommitTask,
  mergeTask as apiMergeTask,
  getCommits as apiGetCommits,
  resetTask as apiResetTask,
  rebaseToTask as apiRebaseToTask,
  getBranches as apiGetBranches,
} from "../../api";
import type { Task, BlitzTask } from "../../data/types";

type ViewMode = "list" | "info" | "terminal";

interface BlitzPageProps {
  onSwitchToZen: () => void;
}

export function BlitzPage({ onSwitchToZen }: BlitzPageProps) {
  const { blitzTasks, isLoading, refresh } = useBlitzTasks();
  const { getTaskNotification, dismissNotification } = useNotifications();

  const [selectedBlitzTask, setSelectedBlitzTask] = useState<BlitzTask | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  // Commit dialog state
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Merge dialog state
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Post-merge archive confirm
  const [showArchiveAfterMerge, setShowArchiveAfterMerge] = useState(false);
  const [mergedTaskId, setMergedTaskId] = useState<string | null>(null);
  const [mergedTaskName, setMergedTaskName] = useState<string>("");
  const [mergedProjectId, setMergedProjectId] = useState<string | null>(null);

  // Clean confirm
  const [showCleanConfirm, setShowCleanConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);

  // Reset confirm
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Rebase dialog
  const [showRebaseDialog, setShowRebaseDialog] = useState(false);
  const [isRebasing, setIsRebasing] = useState(false);
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);

  // Toast
  const [operationMessage, setOperationMessage] = useState<string | null>(null);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ task: Task; position: { x: number; y: number } } | null>(null);

  // Help overlay
  const [showHelp, setShowHelp] = useState(false);

  // Info panel tab
  const [infoPanelTab, setInfoPanelTab] = useState<TabType>("stats");

  // Search input ref
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Derived helpers
  const activeProjectId = selectedBlitzTask?.projectId ?? null;
  const selectedTask = selectedBlitzTask?.task ?? null;

  // Filter tasks by search query (match task name, branch, or project name)
  const filteredTasks = useMemo(() => {
    if (!searchQuery) return blitzTasks;
    const q = searchQuery.toLowerCase();
    return blitzTasks.filter(
      (bt) =>
        bt.task.name.toLowerCase().includes(q) ||
        bt.task.branch.toLowerCase().includes(q) ||
        bt.projectName.toLowerCase().includes(q)
    );
  }, [blitzTasks, searchQuery]);

  // Keep selectedBlitzTask in sync with refreshed data
  const currentSelected = useMemo(() => {
    if (!selectedBlitzTask) return null;
    return filteredTasks.find((bt) => bt.task.id === selectedBlitzTask.task.id && bt.projectId === selectedBlitzTask.projectId) ?? selectedBlitzTask;
  }, [filteredTasks, selectedBlitzTask]);

  const displayTasks = filteredTasks;

  const showMessage = (message: string) => {
    setOperationMessage(message);
    setTimeout(() => setOperationMessage(null), 3000);
  };

  // --- Handlers ---
  const handleSelectTask = (bt: BlitzTask) => {
    setSelectedBlitzTask(bt);
    if (bt.task.status !== "archived") {
      setViewMode("terminal");
      setReviewOpen(false);
      setEditorOpen(false);
    } else if (viewMode === "list") {
      setViewMode("info");
    }
  };

  const handleDoubleClickTask = (bt: BlitzTask) => {
    if (bt.task.status === "archived") return;
    setSelectedBlitzTask(bt);
    setViewMode("terminal");
    setReviewOpen(false);
    setEditorOpen(false);
  };

  const handleCloseTask = () => {
    if (viewMode === "terminal") {
      setViewMode("info");
      setReviewOpen(false);
      setEditorOpen(false);
    } else {
      setSelectedBlitzTask(null);
      setViewMode("list");
    }
  };

  const handleEnterTerminal = () => {
    if (selectedTask?.status === "archived") return;
    setViewMode("terminal");
  };

  const handleToggleReview = () => {
    if (!reviewOpen) setEditorOpen(false);
    setReviewOpen(!reviewOpen);
  };

  const handleToggleEditor = () => {
    if (!editorOpen) setReviewOpen(false);
    setEditorOpen(!editorOpen);
  };

  const handleReviewFromInfo = () => {
    setViewMode("terminal");
    setReviewOpen(true);
    setEditorOpen(false);
  };

  const handleEditorFromInfo = () => {
    setViewMode("terminal");
    setEditorOpen(true);
    setReviewOpen(false);
  };

  const handleStartSession = () => {
    setViewMode("terminal");
  };

  const handleTerminalConnected = useCallback(async () => {
    await refresh();
  }, [refresh]);

  // --- Actions ---
  const handleCommit = () => {
    setCommitError(null);
    setShowCommitDialog(true);
  };

  const handleCommitSubmit = useCallback(async (message: string) => {
    if (!activeProjectId || !selectedTask) return;
    try {
      setIsCommitting(true);
      setCommitError(null);
      const result = await apiCommitTask(activeProjectId, selectedTask.id, message);
      if (result.success) {
        showMessage("Changes committed successfully");
        setShowCommitDialog(false);
        await refresh();
      } else {
        setCommitError(result.message || "Commit failed");
      }
    } catch {
      setCommitError("Failed to commit changes");
    } finally {
      setIsCommitting(false);
    }
  }, [activeProjectId, selectedTask, refresh]);

  const handleRebase = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const branchesRes = await apiGetBranches(activeProjectId);
      setAvailableBranches(branchesRes.branches.map((b) => b.name));
      setShowRebaseDialog(true);
    } catch {
      showMessage("Failed to load branches");
    }
  }, [activeProjectId]);

  const handleRebaseSubmit = useCallback(async (newTarget: string) => {
    if (!activeProjectId || !selectedTask || isRebasing) return;
    try {
      setIsRebasing(true);
      const result = await apiRebaseToTask(activeProjectId, selectedTask.id, newTarget);
      if (result.success) {
        showMessage(result.message || "Target branch changed");
        setShowRebaseDialog(false);
        await refresh();
        setSelectedBlitzTask((prev) =>
          prev ? { ...prev, task: { ...prev.task, target: newTarget } } : null
        );
      } else {
        showMessage(result.message || "Failed to change target branch");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message :
        (err as { message?: string })?.message || "Failed to change target branch";
      showMessage(errorMessage);
    } finally {
      setIsRebasing(false);
    }
  }, [activeProjectId, selectedTask, isRebasing, refresh]);

  const handleSync = useCallback(async () => {
    if (!activeProjectId || !selectedTask || isSyncing) return;
    try {
      setIsSyncing(true);
      const result = await apiSyncTask(activeProjectId, selectedTask.id);
      showMessage(result.message || (result.success ? "Synced successfully" : "Sync failed"));
      if (result.success) await refresh();
    } catch {
      showMessage("Failed to sync task");
    } finally {
      setIsSyncing(false);
    }
  }, [activeProjectId, selectedTask, isSyncing, refresh]);

  const handleMerge = useCallback(async () => {
    if (!activeProjectId || !selectedTask || isMerging) return;
    try {
      const commitsRes = await apiGetCommits(activeProjectId, selectedTask.id);
      if (commitsRes.total <= 1) {
        setIsMerging(true);
        const result = await apiMergeTask(activeProjectId, selectedTask.id, "merge-commit");
        setIsMerging(false);
        if (result.success) {
          showMessage(result.message || "Merged successfully");
          await refresh();
          setMergedTaskId(selectedTask.id);
          setMergedTaskName(selectedTask.name);
          setMergedProjectId(activeProjectId);
          setShowArchiveAfterMerge(true);
        } else {
          showMessage(result.message || "Merge failed");
        }
      } else {
        setMergeError(null);
        setShowMergeDialog(true);
      }
    } catch {
      setMergeError(null);
      setShowMergeDialog(true);
    }
  }, [activeProjectId, selectedTask, isMerging, refresh]);

  const handleMergeSubmit = useCallback(async (method: "squash" | "merge-commit") => {
    if (!activeProjectId || !selectedTask || isMerging) return;
    try {
      setIsMerging(true);
      setMergeError(null);
      const result = await apiMergeTask(activeProjectId, selectedTask.id, method);
      if (result.success) {
        showMessage(result.message || "Merged successfully");
        setShowMergeDialog(false);
        await refresh();
        setMergedTaskId(selectedTask.id);
        setMergedTaskName(selectedTask.name);
        setMergedProjectId(activeProjectId);
        setShowArchiveAfterMerge(true);
      } else {
        setMergeError(result.message || "Merge failed");
      }
    } catch {
      setMergeError("Failed to merge task");
    } finally {
      setIsMerging(false);
    }
  }, [activeProjectId, selectedTask, isMerging, refresh]);

  const handleArchiveAfterMerge = useCallback(async () => {
    if (!mergedProjectId || !mergedTaskId) return;
    try {
      await apiArchiveTask(mergedProjectId, mergedTaskId);
      await refresh();
      showMessage("Task archived");
    } catch {
      showMessage("Failed to archive task");
    } finally {
      setShowArchiveAfterMerge(false);
      setMergedTaskId(null);
      setMergedTaskName("");
      setMergedProjectId(null);
      setSelectedBlitzTask(null);
      setViewMode("list");
    }
  }, [mergedProjectId, mergedTaskId, refresh]);

  const handleSkipArchive = useCallback(() => {
    setShowArchiveAfterMerge(false);
    setMergedTaskId(null);
    setMergedTaskName("");
    setMergedProjectId(null);
    setSelectedBlitzTask(null);
    setViewMode("list");
  }, []);

  const handleArchive = useCallback(async () => {
    if (!activeProjectId || !selectedTask) return;
    try {
      await apiArchiveTask(activeProjectId, selectedTask.id);
      await refresh();
      setSelectedBlitzTask(null);
      setViewMode("list");
    } catch {
      showMessage("Failed to archive task");
    }
  }, [activeProjectId, selectedTask, refresh]);

  const handleClean = () => {
    setShowCleanConfirm(true);
  };

  const handleCleanConfirm = useCallback(async () => {
    if (!activeProjectId || !selectedTask || isDeleting) return;
    try {
      setIsDeleting(true);
      await apiDeleteTask(activeProjectId, selectedTask.id);
      await refresh();
      showMessage("Task deleted successfully");
      setSelectedBlitzTask(null);
      setViewMode("list");
    } catch {
      showMessage("Failed to delete task");
    } finally {
      setIsDeleting(false);
      setShowCleanConfirm(false);
    }
  }, [activeProjectId, selectedTask, isDeleting, refresh]);

  const handleReset = () => {
    setShowResetConfirm(true);
  };

  const handleResetConfirm = useCallback(async () => {
    if (!activeProjectId || !selectedTask || isResetting) return;
    try {
      setIsResetting(true);
      const result = await apiResetTask(activeProjectId, selectedTask.id);
      if (result.success) {
        showMessage(result.message || "Task reset successfully");
        await refresh();
      } else {
        showMessage(result.message || "Reset failed");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message :
        (err as { message?: string })?.message || "Failed to reset task";
      showMessage(errorMessage);
    } finally {
      setIsResetting(false);
      setShowResetConfirm(false);
    }
  }, [activeProjectId, selectedTask, isResetting, refresh]);

  // Context menu
  const handleContextMenu = useCallback((bt: BlitzTask, e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedBlitzTask(bt);
    setContextMenu({ task: bt.task, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const getContextMenuItems = (task: Task): ContextMenuItem[] => {
    const canOperate = task.status !== "broken";
    return [
      { id: "terminal", label: "Enter Terminal", icon: Terminal, variant: "default", onClick: () => { if (currentSelected) handleDoubleClickTask(currentSelected); } },
      { id: "div-1", label: "", divider: true, onClick: () => {} },
      { id: "commit", label: "Commit", icon: GitCommit, variant: "default", onClick: handleCommit },
      { id: "rebase", label: "Rebase", icon: GitBranchPlus, variant: "default", onClick: handleRebase, disabled: !canOperate },
      { id: "sync", label: "Sync", icon: RefreshCw, variant: "default", onClick: handleSync, disabled: !canOperate },
      { id: "merge", label: "Merge", icon: GitMerge, variant: "default", onClick: handleMerge, disabled: !canOperate },
      { id: "div-2", label: "", divider: true, onClick: () => {} },
      { id: "archive", label: "Archive", icon: Archive, variant: "warning", onClick: handleArchive, disabled: task.status === "broken" },
      { id: "reset", label: "Reset", icon: RotateCcw, variant: "warning", onClick: handleReset },
      { id: "clean", label: "Clean", icon: Trash2, variant: "danger", onClick: handleClean },
    ];
  };

  // --- Hotkey helpers ---
  const selectNextTask = useCallback(() => {
    if (displayTasks.length === 0) return;
    const currentIndex = currentSelected
      ? displayTasks.findIndex((bt) => bt.task.id === currentSelected.task.id && bt.projectId === currentSelected.projectId)
      : -1;
    const nextIndex = currentIndex < displayTasks.length - 1 ? currentIndex + 1 : 0;
    const next = displayTasks[nextIndex];
    setSelectedBlitzTask(next);
    if (viewMode === "list") setViewMode("info");
    const el = document.querySelector(`[data-task-id="${next.task.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [displayTasks, currentSelected, viewMode]);

  const selectPreviousTask = useCallback(() => {
    if (displayTasks.length === 0) return;
    const currentIndex = currentSelected
      ? displayTasks.findIndex((bt) => bt.task.id === currentSelected.task.id && bt.projectId === currentSelected.projectId)
      : -1;
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : displayTasks.length - 1;
    const prev = displayTasks[prevIndex];
    setSelectedBlitzTask(prev);
    if (viewMode === "list") setViewMode("info");
    const el = document.querySelector(`[data-task-id="${prev.task.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [displayTasks, currentSelected, viewMode]);

  const openContextMenuAtSelectedTask = useCallback(() => {
    if (!selectedTask) return;
    const el = document.querySelector(`[data-task-id="${selectedTask.id}"]`);
    if (el) {
      const rect = el.getBoundingClientRect();
      setContextMenu({
        task: selectedTask,
        position: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      });
    }
  }, [selectedTask]);

  const hasTask = !!selectedTask;
  const isActive = hasTask && selectedTask.status !== "archived";
  const canOperate = isActive && selectedTask.status !== "broken";
  const notTerminal = viewMode !== "terminal";

  useHotkeys(
    [
      { key: "j", handler: selectNextTask, options: { enabled: notTerminal } },
      { key: "ArrowDown", handler: selectNextTask, options: { enabled: notTerminal } },
      { key: "k", handler: selectPreviousTask, options: { enabled: notTerminal } },
      { key: "ArrowUp", handler: selectPreviousTask, options: { enabled: notTerminal } },
      {
        key: "Enter",
        handler: () => {
          if (viewMode === "info" && selectedTask && selectedTask.status !== "archived") {
            handleEnterTerminal();
          } else if (viewMode === "list" && selectedTask) {
            setViewMode("info");
          }
        },
        options: { enabled: notTerminal && hasTask },
      },
      { key: "Escape", handler: handleCloseTask, options: { enabled: viewMode !== "list" } },

      // Info panel tabs
      { key: "1", handler: () => setInfoPanelTab("stats"), options: { enabled: notTerminal && hasTask } },
      { key: "2", handler: () => setInfoPanelTab("git"), options: { enabled: notTerminal && hasTask } },
      { key: "3", handler: () => setInfoPanelTab("notes"), options: { enabled: notTerminal && hasTask } },
      { key: "4", handler: () => setInfoPanelTab("comments"), options: { enabled: notTerminal && hasTask } },

      // Actions (no 'n' for new task)
      { key: "Space", handler: openContextMenuAtSelectedTask, options: { enabled: hasTask && notTerminal } },
      { key: "c", handler: handleCommit, options: { enabled: isActive } },
      { key: "s", handler: handleSync, options: { enabled: canOperate } },
      { key: "m", handler: handleMerge, options: { enabled: canOperate } },
      { key: "b", handler: handleRebase, options: { enabled: canOperate } },
      { key: "a", handler: handleArchive, options: { enabled: isActive && selectedTask?.status !== "broken" } },
      { key: "x", handler: handleClean, options: { enabled: hasTask } },
      {
        key: "r",
        handler: () => {
          if (isActive) handleReset();
        },
        options: { enabled: hasTask && isActive },
      },

      // Search
      { key: "/", handler: () => searchInputRef.current?.focus(), options: { enabled: notTerminal } },

      // Help
      { key: "?", handler: () => setShowHelp((v) => !v) },
    ],
    [
      selectNextTask, selectPreviousTask, handleCloseTask,
      handleEnterTerminal, openContextMenuAtSelectedTask,
      handleCommit, handleSync, handleMerge, handleRebase,
      handleArchive, handleClean, handleReset,
      viewMode, selectedTask, hasTask, isActive, canOperate, notTerminal,
    ]
  );

  const isTerminalMode = viewMode === "terminal";
  const isInfoMode = viewMode === "info";

  return (
    <>
      {/* Blitz Sidebar — replaces the normal app sidebar */}
      <aside className="w-72 h-screen bg-[var(--color-bg)] border-r border-[var(--color-border)] flex flex-col flex-shrink-0">
        {/* Logo + Mode Brand */}
        <div className="p-4">
          <LogoBrand mode="blitz" onToggle={onSwitchToZen} />
        </div>

        {/* Search */}
        <div className="p-3 border-b border-[var(--color-border)]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSearchQuery("");
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Search tasks or projects..."
              className="w-full pl-9 pr-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
                text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)]
                focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                transition-all duration-200"
            />
          </div>
        </div>

        {/* Task List */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="relative">
              {Array.from({ length: 8 }).map((_, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, scaleX: 0 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  transition={{ delay: i * 0.07, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="px-3 py-3 border-b border-[var(--color-border)] origin-left"
                >
                  <div className="relative overflow-hidden rounded">
                    {/* Shimmer sweep */}
                    <div
                      className="absolute inset-0 animate-[shimmer_1.5s_ease-in-out_infinite]"
                      style={{
                        background: "linear-gradient(90deg, transparent 0%, rgba(245,158,11,0.08) 40%, rgba(245,158,11,0.15) 50%, rgba(245,158,11,0.08) 60%, transparent 100%)",
                        animationDelay: `${i * 0.12}s`,
                      }}
                    />
                    <div className="flex items-center gap-2.5">
                      <div className="w-3 h-3 rounded-full bg-[var(--color-bg-tertiary)]" />
                      <div
                        className="h-3 rounded bg-[var(--color-bg-tertiary)]"
                        style={{ width: `${50 + ((i * 37) % 40)}%` }}
                      />
                    </div>
                    <div className="flex items-center gap-2 mt-2 ml-5.5">
                      <div className="h-3.5 w-14 rounded bg-[var(--color-bg-tertiary)]" />
                      <div className="h-3 w-10 rounded bg-[var(--color-bg-tertiary)]" />
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-[var(--color-text-muted)]">No active tasks</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 px-2 py-1">
              {displayTasks.map((bt, index) => {
                const notif = getTaskNotification(bt.task.id);
                const isThisSelected =
                  currentSelected?.task.id === bt.task.id &&
                  currentSelected?.projectId === bt.projectId;
                return (
                  <motion.div
                    key={`${bt.projectId}-${bt.task.id}`}
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      opacity: { delay: index * 0.06, duration: 0.35 },
                      x: { delay: index * 0.06, duration: 0.35, ease: [0.22, 1, 0.36, 1] },
                    }}
                  >
                    <BlitzTaskListItem
                      blitzTask={bt}
                      isSelected={isThisSelected}
                      onClick={() => {
                        if (notif) {
                          dismissNotification(notif.project_id, notif.task_id);
                        }
                        handleSelectTask(bt);
                      }}
                      onDoubleClick={() => handleDoubleClickTask(bt)}
                      onContextMenu={(e) => handleContextMenu(bt, e)}
                      notification={notif ? { level: notif.level } : undefined}
                    />
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>

        {/* Help shortcut hint */}
        <div className="px-3 py-2 border-t border-[var(--color-border)]">
          <button
            onClick={() => setShowHelp(true)}
            className="w-full text-center text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Press <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">?</kbd> for shortcuts
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden relative">
        {/* Aurora background */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div
            className="absolute -inset-[50%] opacity-[0.25] animate-[aurora_20s_ease-in-out_infinite]"
            style={{
              background: "conic-gradient(from 0deg at 50% 50%, #f59e0b, #8b5cf6, #06b6d4, #10b981, #f59e0b)",
              filter: "blur(50px)",
            }}
          />
        </div>
        <div className="h-full p-6 relative z-[1]">
          <div className="h-full relative">
            {/* List + Info Mode */}
            <motion.div
              animate={{
                opacity: isTerminalMode ? 0 : 1,
                x: isTerminalMode ? -20 : 0,
              }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className={`absolute inset-0 ${isTerminalMode ? "pointer-events-none" : ""}`}
            >
              <AnimatePresence mode="wait">
                {isInfoMode && currentSelected ? (
                  <motion.div
                    key="info-panel"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ type: "spring", damping: 25, stiffness: 200 }}
                    className="h-full"
                  >
                    <TaskInfoPanel
                      projectId={currentSelected.projectId}
                      task={currentSelected.task}
                      projectName={currentSelected.projectName}
                      onClose={handleCloseTask}
                      onEnterTerminal={currentSelected.task.status !== "archived" ? handleEnterTerminal : undefined}
                      onClean={handleClean}
                      onCommit={currentSelected.task.status !== "archived" ? handleCommit : undefined}
                      onReview={currentSelected.task.status !== "archived" ? handleReviewFromInfo : undefined}
                      onEditor={currentSelected.task.status !== "archived" ? handleEditorFromInfo : undefined}
                      onRebase={currentSelected.task.status !== "archived" ? handleRebase : undefined}
                      onSync={currentSelected.task.status !== "archived" ? handleSync : undefined}
                      onMerge={currentSelected.task.status !== "archived" ? handleMerge : undefined}
                      onArchive={currentSelected.task.status !== "archived" ? handleArchive : undefined}
                      onReset={currentSelected.task.status !== "archived" ? handleReset : undefined}
                      activeTab={infoPanelTab}
                      onTabChange={setInfoPanelTab}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="empty-state"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="h-full flex items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
                  >
                    <div className="text-center">
                      <p className="text-[var(--color-text-muted)] mb-2">
                        Select a task to view details
                      </p>
                      <p className="text-sm text-[var(--color-text-muted)]">
                        Press <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg)] border-[var(--color-border)]">?</kbd> for keyboard shortcuts
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

            {/* Terminal Mode */}
            <AnimatePresence>
              {isTerminalMode && currentSelected && (
                <motion.div
                  initial={{ x: "100%", opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: "100%", opacity: 0 }}
                  transition={{ type: "spring", damping: 25, stiffness: 200 }}
                  className="absolute inset-0 flex gap-3"
                >
                  <TaskInfoPanel
                    projectId={currentSelected.projectId}
                    task={currentSelected.task}
                    projectName={currentSelected.projectName}
                    onClose={handleCloseTask}
                    isTerminalMode
                  />
                  <TaskView
                    projectId={currentSelected.projectId}
                    task={currentSelected.task}
                    projectName={currentSelected.projectName}
                    reviewOpen={reviewOpen}
                    editorOpen={editorOpen}
                    onToggleReview={handleToggleReview}
                    onToggleEditor={handleToggleEditor}
                    onCommit={handleCommit}
                    onRebase={handleRebase}
                    onSync={handleSync}
                    onMerge={handleMerge}
                    onArchive={handleArchive}
                    onClean={handleClean}
                    onReset={handleReset}
                    onStartSession={handleStartSession}
                    onTerminalConnected={handleTerminalConnected}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

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

      {/* Dialogs */}
      <CommitDialog
        isOpen={showCommitDialog}
        isLoading={isCommitting}
        error={commitError}
        onCommit={handleCommitSubmit}
        onCancel={() => { setShowCommitDialog(false); setCommitError(null); }}
      />

      <MergeDialog
        isOpen={showMergeDialog}
        taskName={selectedTask?.name || ""}
        branchName={selectedTask?.branch || ""}
        targetBranch={selectedTask?.target || ""}
        isLoading={isMerging}
        error={mergeError}
        onMerge={handleMergeSubmit}
        onCancel={() => { setShowMergeDialog(false); setMergeError(null); }}
      />

      <ConfirmDialog
        isOpen={showCleanConfirm}
        title="Delete Task"
        message={`Are you sure you want to delete "${selectedTask?.name}"? This will remove the worktree and all associated data. This action cannot be undone.`}
        confirmLabel={isDeleting ? "Deleting..." : "Delete"}
        variant="danger"
        onConfirm={handleCleanConfirm}
        onCancel={() => setShowCleanConfirm(false)}
      />

      <ConfirmDialog
        isOpen={showArchiveAfterMerge}
        title="Merge Successful"
        message={`"${mergedTaskName}" has been merged successfully. Would you like to archive this task?`}
        confirmLabel="Archive"
        cancelLabel="Keep"
        variant="info"
        onConfirm={handleArchiveAfterMerge}
        onCancel={handleSkipArchive}
      />

      <ConfirmDialog
        isOpen={showResetConfirm}
        title="Reset Task"
        message={`Are you sure you want to reset "${selectedTask?.name}"? This will discard all changes and recreate the worktree from ${selectedTask?.target}. This action cannot be undone.`}
        confirmLabel={isResetting ? "Resetting..." : "Reset"}
        variant="danger"
        onConfirm={handleResetConfirm}
        onCancel={() => setShowResetConfirm(false)}
      />

      <RebaseDialog
        isOpen={showRebaseDialog}
        taskName={selectedTask?.name}
        currentTarget={selectedTask?.target || ""}
        availableBranches={availableBranches}
        onClose={() => setShowRebaseDialog(false)}
        onRebase={handleRebaseSubmit}
      />

      <ContextMenu
        items={contextMenu ? getContextMenuItems(contextMenu.task) : []}
        position={contextMenu?.position ?? null}
        onClose={closeContextMenu}
      />

      <HelpOverlay isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </>
  );
}
