import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search } from "lucide-react";
import { TaskInfoPanel } from "../Tasks/TaskInfoPanel";
import { TaskView } from "../Tasks/TaskView";
import { CommitDialog, ConfirmDialog, MergeDialog } from "../Dialogs";
import { RebaseDialog } from "../Tasks/dialogs";
import { HelpOverlay } from "../Tasks/HelpOverlay";
import { ContextMenu } from "../ui/ContextMenu";
import { LogoBrand } from "../Layout/LogoBrand";
import { useNotifications } from "../../context";
import {
  useHotkeys,
  useTaskPageState,
  useTaskNavigation,
  usePostMergeArchive,
  useTaskOperations,
} from "../../hooks";
import { useBlitzTasks } from "./useBlitzTasks";
import { BlitzTaskListItem } from "./BlitzTaskListItem";
import type { BlitzTask } from "../../data/types";
import type { PendingArchiveConfirm } from "../../utils/archiveHelpers";
import { buildContextMenuItems, type TaskOperationHandlers } from "../../utils/taskOperationUtils";


interface BlitzPageProps {
  onSwitchToZen: () => void;
}

export function BlitzPage({ onSwitchToZen }: BlitzPageProps) {
  const { blitzTasks, isLoading, refresh } = useBlitzTasks();
  const { getTaskNotification, dismissNotification } = useNotifications();

  // Blitz-specific state
  const [selectedBlitzTask, setSelectedBlitzTask] = useState<BlitzTask | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [taskOrder, setTaskOrder] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Archive confirmation state (shared between hooks)
  const [pendingArchiveConfirm, setPendingArchiveConfirm] = useState<PendingArchiveConfirm | null>(null);

  // Derived helpers
  const activeProjectId = selectedBlitzTask?.projectId ?? null;
  const selectedTask = selectedBlitzTask?.task ?? null;

  // Page state hook
  const [pageState, pageHandlers] = useTaskPageState();

  // Post-merge archive hook (with Blitz-specific projectId tracking)
  const [postMergeState, postMergeHandlers] = usePostMergeArchive({
    projectId: activeProjectId,
    onRefresh: refresh,
    onShowMessage: pageHandlers.showMessage,
    onCleanup: () => {
      setSelectedBlitzTask(null);
      pageHandlers.setViewMode("list");
    },
    setPendingArchiveConfirm,
  });

  // Task operations hook
  const [opsState, opsHandlers] = useTaskOperations({
    projectId: activeProjectId,
    selectedTask,
    onRefresh: refresh,
    onShowMessage: pageHandlers.showMessage,
    onTaskArchived: () => {
      setSelectedBlitzTask(null);
      pageHandlers.setViewMode("list");
    },
    onTaskMerged: (taskId, taskName) => {
      // Blitz: pass mergedProjectId for cross-project operations
      postMergeHandlers.triggerPostMergeArchive(taskId, taskName, activeProjectId ?? undefined);
    },
    setPendingArchiveConfirm,
  });

  // Filter tasks by search query (match task name, branch, or project name)
  const filteredTasks = useMemo(() => {
    if (!pageState.searchQuery) return blitzTasks;
    const q = pageState.searchQuery.toLowerCase();
    return blitzTasks.filter(
      (bt) =>
        bt.task.name.toLowerCase().includes(q) ||
        bt.task.branch.toLowerCase().includes(q) ||
        bt.projectName.toLowerCase().includes(q)
    );
  }, [blitzTasks, pageState.searchQuery]);

  // Keep selectedBlitzTask in sync with refreshed data
  const currentSelected = useMemo(() => {
    if (!selectedBlitzTask) return null;
    return filteredTasks.find((bt) => bt.task.id === selectedBlitzTask.task.id && bt.projectId === selectedBlitzTask.projectId) ?? selectedBlitzTask;
  }, [filteredTasks, selectedBlitzTask]);

  // Initialize task order when filtered tasks change
  useEffect(() => {
    if (filteredTasks.length > 0 && taskOrder.length === 0) {
      setTaskOrder(filteredTasks.map(bt => `${bt.projectId}:${bt.task.id}`));
    }
  }, [filteredTasks, taskOrder.length]);

  // Apply custom order to tasks
  const displayTasks = useMemo(() => {
    if (taskOrder.length === 0) return filteredTasks;

    const taskMap = new Map(filteredTasks.map(bt => [`${bt.projectId}:${bt.task.id}`, bt]));
    const ordered = taskOrder
      .map(key => taskMap.get(key))
      .filter((bt): bt is BlitzTask => bt !== undefined);

    // Add any new tasks that aren't in the order yet
    const orderedKeys = new Set(taskOrder);
    const newTasks = filteredTasks.filter(bt => !orderedKeys.has(`${bt.projectId}:${bt.task.id}`));

    return [...ordered, ...newTasks];
  }, [filteredTasks, taskOrder]);

  // Listen for Command key press for quick navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only listen for Command key (metaKey), not Control
      if (e.metaKey) {
        // Add CSS class to body to show shortcuts (no React re-render)
        document.body.classList.add('blitz-command-pressed');

        // Handle Command+0-9 for quick navigation
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          const index = e.key === '0' ? 9 : parseInt(e.key) - 1; // 1->0, 2->1, ..., 0->9
          if (index < displayTasks.length) {
            const taskToSelect = displayTasks[index];
            const notif = getTaskNotification(taskToSelect.task.id);
            if (notif) {
              dismissNotification(notif.project_id, notif.task_id);
            }
            handleSelectTask(taskToSelect);
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.metaKey) {
        document.body.classList.remove('blitz-command-pressed');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Handle window blur (when user switches apps while holding Command)
    const handleBlur = () => {
      document.body.classList.remove('blitz-command-pressed');
    };
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      // Clean up class on unmount
      document.body.classList.remove('blitz-command-pressed');
    };
  }, [displayTasks, getTaskNotification, dismissNotification]);

  // Task selection handlers (Blitz-specific: handle BlitzTask)
  const handleSelectTask = useCallback((bt: BlitzTask) => {
    setSelectedBlitzTask(bt);
    if (bt.task.status !== "archived") {
      pageHandlers.setViewMode("terminal");
      pageHandlers.setReviewOpen(false);
      pageHandlers.setEditorOpen(false);
    } else if (pageState.viewMode === "list") {
      pageHandlers.setViewMode("info");
    }
  }, [pageHandlers, pageState.viewMode]);

  const handleDoubleClickTask = useCallback((bt: BlitzTask) => {
    if (bt.task.status === "archived") return;
    setSelectedBlitzTask(bt);
    pageHandlers.setViewMode("terminal");
    pageHandlers.setReviewOpen(false);
    pageHandlers.setEditorOpen(false);
  }, [pageHandlers]);

  // Drag and drop handlers
  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (index: number) => {
    if (draggedIndex === null || draggedIndex === index) return;
    setDragOverIndex(index);
  };

  const handleDragEnd = () => {
    if (draggedIndex === null || dragOverIndex === null || draggedIndex === dragOverIndex) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newOrder = [...taskOrder];
    const [movedItem] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(dragOverIndex, 0, movedItem);

    setTaskOrder(newOrder);
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  // Context menu handler (Blitz-specific: handle BlitzTask)
  const handleContextMenu = useCallback((bt: BlitzTask, e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedBlitzTask(bt);
    pageHandlers.handleContextMenu(bt.task, e);
  }, [pageHandlers]);

  // Wrap page handlers to handle selectedBlitzTask
  const handleCloseTask = useCallback(() => {
    if (pageState.viewMode === "terminal") {
      pageHandlers.handleCloseTask();
    } else {
      setSelectedBlitzTask(null);
      pageHandlers.setViewMode("list");
    }
  }, [pageState.viewMode, pageHandlers]);

  // Deprecated - page is no longer in use
  // const handleStartSession = useCallback(() => {
  //   pageHandlers.setViewMode("terminal");
  // }, [pageHandlers]);

  // const handleTerminalConnected = useCallback(async () => {
  //   await refresh();
  // }, [refresh]);

  // const handleTerminalDisconnected = useCallback(async () => {
  //   await refresh();
  // }, [refresh]);

  // Task navigation hook (for Blitz tasks)
  const navHandlers = useTaskNavigation({
    tasks: displayTasks.map(bt => bt.task),
    selectedTask,
    viewMode: pageState.viewMode,
    onSelectTask: (task) => {
      const bt = displayTasks.find(t => t.task.id === task.id);
      if (bt) handleSelectTask(bt);
    },
    setViewMode: pageHandlers.setViewMode,
    setContextMenu: pageHandlers.setContextMenu,
  });

  // Build context menu items
  const contextMenuItems = pageState.contextMenu
    ? buildContextMenuItems(pageState.contextMenu.task, {
        onEnterTerminal: () => {
          if (currentSelected) handleDoubleClickTask(currentSelected);
        },
        onCommit: opsHandlers.handleCommit,
        onRebase: opsHandlers.handleRebase,
        onSync: opsHandlers.handleSync,
        onMerge: opsHandlers.handleMerge,
        onArchive: opsHandlers.handleArchive,
        onReset: opsHandlers.handleReset,
        onClean: opsHandlers.handleClean,
      } as TaskOperationHandlers)
    : [];

  const hasTask = !!selectedTask;
  const isActive = hasTask && selectedTask.status !== "archived";
  const canOperate = isActive && selectedTask.status !== "broken";
  const notTerminal = pageState.viewMode !== "terminal";

  useHotkeys(
    [
      { key: "j", handler: navHandlers.selectNextTask, options: { enabled: notTerminal } },
      { key: "ArrowDown", handler: navHandlers.selectNextTask, options: { enabled: notTerminal } },
      { key: "k", handler: navHandlers.selectPreviousTask, options: { enabled: notTerminal } },
      { key: "ArrowUp", handler: navHandlers.selectPreviousTask, options: { enabled: notTerminal } },
      {
        key: "Enter",
        handler: () => {
          if (pageState.viewMode === "info" && selectedTask && selectedTask.status !== "archived") {
            pageHandlers.handleEnterTerminal();
          } else if (pageState.viewMode === "list" && selectedTask) {
            pageHandlers.setViewMode("info");
          }
        },
        options: { enabled: notTerminal && hasTask },
      },
      { key: "Escape", handler: handleCloseTask, options: { enabled: pageState.viewMode !== "list" } },

      // Info panel tabs
      { key: "1", handler: () => pageHandlers.setInfoPanelTab("stats"), options: { enabled: notTerminal && hasTask } },
      { key: "2", handler: () => pageHandlers.setInfoPanelTab("git"), options: { enabled: notTerminal && hasTask } },
      { key: "3", handler: () => pageHandlers.setInfoPanelTab("notes"), options: { enabled: notTerminal && hasTask } },
      { key: "4", handler: () => pageHandlers.setInfoPanelTab("comments"), options: { enabled: notTerminal && hasTask } },

      // Actions (no 'n' for new task)
      { key: "Space", handler: navHandlers.openContextMenuAtSelectedTask, options: { enabled: hasTask && notTerminal } },
      { key: "c", handler: opsHandlers.handleCommit, options: { enabled: isActive } },
      { key: "s", handler: opsHandlers.handleSync, options: { enabled: canOperate } },
      { key: "m", handler: opsHandlers.handleMerge, options: { enabled: canOperate } },
      { key: "b", handler: opsHandlers.handleRebase, options: { enabled: canOperate } },
      { key: "r", handler: pageHandlers.handleReviewShortcut, options: { enabled: isActive } },
      { key: "e", handler: pageHandlers.handleEditorShortcut, options: { enabled: isActive } },
      { key: "t", handler: pageHandlers.handleTerminalShortcut, options: { enabled: isActive } },

      // Search
      { key: "/", handler: () => searchInputRef.current?.focus(), options: { enabled: notTerminal } },

      // Help
      { key: "?", handler: () => pageHandlers.setShowHelp(!pageState.showHelp) },
    ],
    [
      navHandlers, pageHandlers, opsHandlers, handleCloseTask,
      pageState.viewMode, pageState.showHelp, selectedTask, hasTask, isActive, canOperate, notTerminal,
    ]
  );

  const isTerminalMode = pageState.viewMode === "terminal";
  const isInfoMode = pageState.viewMode === "info";

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
              value={pageState.searchQuery}
              onChange={(e) => pageHandlers.setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  pageHandlers.setSearchQuery("");
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
                      shortcutNumber={index < 10 ? (index === 9 ? 0 : index + 1) : undefined}
                      onDragStart={() => handleDragStart(index)}
                      onDragOver={() => handleDragOver(index)}
                      onDragEnd={handleDragEnd}
                      onDragLeave={handleDragLeave}
                      isDragging={draggedIndex === index}
                      isDragOver={dragOverIndex === index}
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
            onClick={() => pageHandlers.setShowHelp(true)}
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
                      onEnterMode={currentSelected.task.status !== "archived" ? pageHandlers.handleEnterMode : undefined}
                      enableTerminal={currentSelected.task.enableTerminal}
                      enableChat={currentSelected.task.enableChat}
                      onClean={opsHandlers.handleClean}
                      onCommit={currentSelected.task.status !== "archived" ? opsHandlers.handleCommit : undefined}
                      onReview={currentSelected.task.status !== "archived" ? pageHandlers.handleReviewFromInfo : undefined}
                      onEditor={currentSelected.task.status !== "archived" ? pageHandlers.handleEditorFromInfo : undefined}
                      onRebase={currentSelected.task.status !== "archived" ? opsHandlers.handleRebase : undefined}
                      onSync={currentSelected.task.status !== "archived" ? opsHandlers.handleSync : undefined}
                      onMerge={currentSelected.task.status !== "archived" ? opsHandlers.handleMerge : undefined}
                      onArchive={currentSelected.task.status !== "archived" ? opsHandlers.handleArchive : undefined}
                      onReset={currentSelected.task.status !== "archived" ? opsHandlers.handleReset : undefined}
                      activeTab={pageState.infoPanelTab}
                      onTabChange={pageHandlers.setInfoPanelTab}
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
                    onAddPanel={() => {}}
                    onCommit={opsHandlers.handleCommit}
                    onRebase={opsHandlers.handleRebase}
                    onSync={opsHandlers.handleSync}
                    onMerge={opsHandlers.handleMerge}
                    onArchive={opsHandlers.handleArchive}
                    onClean={opsHandlers.handleClean}
                    onReset={opsHandlers.handleReset}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      {/* Toast */}
      <AnimatePresence>
        {pageState.operationMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-lg"
          >
            <span className="text-sm text-[var(--color-text)]">{pageState.operationMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dialogs */}
      <CommitDialog
        isOpen={opsState.showCommitDialog}
        isLoading={opsState.isCommitting}
        error={opsState.commitError}
        onCommit={opsHandlers.handleCommitSubmit}
        onCancel={opsHandlers.handleCommitCancel}
      />

      <MergeDialog
        isOpen={opsState.showMergeDialog}
        taskName={selectedTask?.name || ""}
        branchName={selectedTask?.branch || ""}
        targetBranch={selectedTask?.target || ""}
        isLoading={opsState.isMerging}
        error={opsState.mergeError}
        onMerge={opsHandlers.handleMergeSubmit}
        onCancel={opsHandlers.handleMergeCancel}
      />

      <ConfirmDialog
        isOpen={opsState.showCleanConfirm}
        title="Delete Task"
        message={`Are you sure you want to delete "${selectedTask?.name}"? This will remove the worktree and all associated data. This action cannot be undone.`}
        confirmLabel={opsState.isDeleting ? "Deleting..." : "Delete"}
        variant="danger"
        onConfirm={opsHandlers.handleCleanConfirm}
        onCancel={opsHandlers.handleCleanCancel}
      />

      <ConfirmDialog
        isOpen={postMergeState.showArchiveAfterMerge}
        title="Merge Complete"
        message={
          <div className="flex flex-col gap-4">
            <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-3">
              <div className="flex justify-between text-sm">
                <span className="text-[var(--color-text-muted)]">Task</span>
                <span className="text-[var(--color-text)] font-medium">{postMergeState.mergedTaskName}</span>
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

      <ConfirmDialog
        isOpen={!!pendingArchiveConfirm}
        title="Archive"
        message={pendingArchiveConfirm?.message || ""}
        variant="warning"
        onConfirm={() => opsHandlers.handleArchiveConfirm(pendingArchiveConfirm)}
        onCancel={() => opsHandlers.handleArchiveCancel(pendingArchiveConfirm)}
      />

      <ConfirmDialog
        isOpen={opsState.showResetConfirm}
        title="Reset Task"
        message={`Are you sure you want to reset "${selectedTask?.name}"? This will discard all changes and recreate the worktree from ${selectedTask?.target}. This action cannot be undone.`}
        confirmLabel={opsState.isResetting ? "Resetting..." : "Reset"}
        variant="danger"
        onConfirm={opsHandlers.handleResetConfirm}
        onCancel={opsHandlers.handleResetCancel}
      />

      <RebaseDialog
        isOpen={opsState.showRebaseDialog}
        taskName={selectedTask?.name}
        currentTarget={selectedTask?.target || ""}
        availableBranches={opsState.availableBranches}
        onClose={opsHandlers.handleRebaseCancel}
        onRebase={opsHandlers.handleRebaseSubmit}
      />

      <ContextMenu
        items={contextMenuItems}
        position={pageState.contextMenu?.position ?? null}
        onClose={pageHandlers.closeContextMenu}
      />

      <HelpOverlay isOpen={pageState.showHelp} onClose={() => pageHandlers.setShowHelp(false)} />
    </>
  );
}
