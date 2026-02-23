import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus } from "lucide-react";
import { TaskSidebar } from "./TaskSidebar/TaskSidebar";
import { TaskInfoPanel } from "./TaskInfoPanel";
import { TaskView, type TaskViewHandle } from "./TaskView";
import { NewTaskDialog } from "./NewTaskDialog";
import { CommitDialog, ConfirmDialog, MergeDialog } from "../Dialogs";
import { RebaseDialog } from "./dialogs";
import { HelpOverlay } from "./HelpOverlay";
import { Button } from "../ui";
import { ContextMenu } from "../ui/ContextMenu";
import { useProject } from "../../context";
import {
  useHotkeys,
  useTaskPageState,
  useTaskNavigation,
  usePostMergeArchive,
  useTaskOperations,
} from "../../hooks";
import {
  createTask as apiCreateTask,
  recoverTask as apiRecoverTask,
  listTasks as apiListTasks,
} from "../../api";
import type { Task, TaskFilter } from "../../data/types";
import { convertTaskResponse } from "../../utils/taskConvert";
import type { PendingArchiveConfirm } from "../../utils/archiveHelpers";
import { buildContextMenuItems, type TaskOperationHandlers } from "../../utils/taskOperationUtils";
import type { PanelType } from "./PanelSystem/types";

interface TasksPageProps {
  /** Initial task ID to select (from navigation) */
  initialTaskId?: string;
  /** Initial view mode to use (from navigation, e.g. "terminal") */
  initialViewMode?: string;
  /** Callback when navigation data has been consumed */
  onNavigationConsumed?: () => void;
}

export function TasksPage({ initialTaskId, initialViewMode, onNavigationConsumed }: TasksPageProps) {
  const { selectedProject, refreshSelectedProject } = useProject();

  // Zen-specific state
  const [filter, setFilter] = useState<TaskFilter>("active");
  const [showNewTaskDialog, setShowNewTaskDialog] = useState(false);
  // const [autoStartSession, setAutoStartSession] = useState(false); // Deprecated
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const taskViewRef = useRef<TaskViewHandle>(null);

  // Archive confirmation state (shared between hooks)
  const [pendingArchiveConfirm, setPendingArchiveConfirm] = useState<PendingArchiveConfirm | null>(null);

  // Page state hook
  const [pageState, pageHandlers] = useTaskPageState();

  // Post-merge archive hook
  const [postMergeState, postMergeHandlers] = usePostMergeArchive({
    projectId: selectedProject?.id ?? null,
    onRefresh: refreshSelectedProject,
    onShowMessage: pageHandlers.showMessage,
    onCleanup: () => {
      pageHandlers.setSelectedTask(null);
      pageHandlers.setInWorkspace(false);
    },
    setPendingArchiveConfirm,
  });

  // Task operations hook
  const [opsState, opsHandlers] = useTaskOperations({
    projectId: selectedProject?.id ?? null,
    selectedTask: pageState.selectedTask,
    onRefresh: refreshSelectedProject,
    onShowMessage: pageHandlers.showMessage,
    onTaskArchived: () => {
      pageHandlers.setSelectedTask(null);
      pageHandlers.setInWorkspace(false);
    },
    onTaskMerged: (taskId, taskName) => {
      postMergeHandlers.triggerPostMergeArchive(taskId, taskName);
    },
    setPendingArchiveConfirm,
  });

  // Load archived tasks when filter changes to "archived"
  // Also filter by current branch
  useEffect(() => {
    let cancelled = false;
    if (filter === "archived" && selectedProject) {
      setIsLoadingArchived(true);
      const currentBranch = selectedProject.currentBranch || "main";
      apiListTasks(selectedProject.id, "archived")
        .then((tasks) => {
          if (cancelled) return;
          const filtered = tasks
            .map(convertTaskResponse)
            .filter((t) => t.target === currentBranch);
          setArchivedTasks(filtered);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("Failed to load archived tasks:", err);
        })
        .finally(() => {
          if (cancelled) return;
          setIsLoadingArchived(false);
        });
    }
    return () => { cancelled = true; };
  }, [filter, selectedProject]);

  // Get tasks for current project (combine active and archived)
  // Filter by target branch matching current branch (except for archived tasks)
  const currentBranch = selectedProject?.currentBranch || "main";
  const activeTasks = (selectedProject?.tasks || []).filter(
    (t) => t.target === currentBranch
  );
  const tasks = filter === "archived" ? archivedTasks : activeTasks;

  // Handle initial task selection from navigation
  useEffect(() => {
    if (initialTaskId && activeTasks.length > 0 && !pageState.selectedTask) {
      const task = activeTasks.find((t) => t.id === initialTaskId);
      if (task) {
        pageHandlers.setSelectedTask(task);
        // If initialViewMode is "terminal", enter Workspace
        if (initialViewMode === "terminal") {
          pageHandlers.setInWorkspace(true);
        }
        // Consume the navigation data so it doesn't re-trigger
        onNavigationConsumed?.();
      }
    }
  }, [initialTaskId, initialViewMode, activeTasks, pageState.selectedTask, onNavigationConsumed, pageHandlers]);

  // Sync selectedTask with latest project data after refresh
  useEffect(() => {
    if (!pageState.selectedTask || !selectedProject?.tasks) return;
    const updated = selectedProject.tasks.find((t) => t.id === pageState.selectedTask!.id);
    if (updated && updated.status !== pageState.selectedTask.status) {
      pageHandlers.setSelectedTask(updated);
    }
  }, [selectedProject?.tasks, pageState.selectedTask, pageHandlers]);

  // Filter, deduplicate, and search tasks
  const filteredTasks = useMemo(() => {
    const seen = new Set<string>();
    return tasks.filter((task) => {
      // Deduplicate by task ID (safety net against stale state accumulation)
      if (seen.has(task.id)) return false;
      seen.add(task.id);

      // For active filter, exclude archived status (in case API returns them)
      if (filter === "active" && task.status === "archived") {
        return false;
      }

      // Apply search query
      if (pageState.searchQuery) {
        const query = pageState.searchQuery.toLowerCase();
        return (
          task.name.toLowerCase().includes(query) ||
          task.branch.toLowerCase().includes(query)
        );
      }

      return true;
    });
  }, [tasks, filter, pageState.searchQuery]);

  // Wrap page handlers to handle auto-start state
  const handleSelectTask = useCallback((task: Task) => {
    // setAutoStartSession(false); // Deprecated
    pageHandlers.handleSelectTask(task);
  }, [pageHandlers]);

  const handleDoubleClickTask = useCallback((task: Task) => {
    // setAutoStartSession(false); // Deprecated
    // Forward to page handlers (task modes are read from task.taskModes)
    pageHandlers.handleDoubleClickTask(task);
  }, [pageHandlers]);

  // Handle recover archived task (Zen-only)
  const handleRecover = useCallback(async () => {
    if (!selectedProject || !pageState.selectedTask) return;
    try {
      await apiRecoverTask(selectedProject.id, pageState.selectedTask.id);
      await refreshSelectedProject();
      // Clear archived tasks cache so it reloads
      setArchivedTasks((prev) => prev.filter((t) => t.id !== pageState.selectedTask?.id));
      // Update local state to reflect the change
      pageHandlers.setSelectedTask(null);
      pageHandlers.setInWorkspace(false);
      // Switch to active filter to see the recovered task
      setFilter("active");
    } catch (err) {
      console.error("Failed to recover task:", err);
      const errorMessage = err instanceof Error ? err.message :
        (err as { message?: string })?.message || "Failed to recover task";
      pageHandlers.showMessage(errorMessage);
    }
  }, [selectedProject, pageState.selectedTask, refreshSelectedProject, pageHandlers]);

  // 统一的 panel 添加处理函数（用于 Terminal/Chat/Review/Editor/Stats/Git/Notes/Comments）
  const handleAddPanel = useCallback((type: PanelType) => {
    console.log(`Opening panel: ${type}`);
    // 调用 TaskView 的 addPanel 方法
    if (taskViewRef.current) {
      taskViewRef.current.addPanel(type);
    }
  }, []);

  // Handle adding panel from Info Panel (方案 A)
  const handleAddPanelFromInfo = useCallback((type: PanelType) => {
    pageHandlers.setInWorkspace(true);
    pageHandlers.setPendingPanel(type);
  }, [pageHandlers]);

  // 方案 A: 使用 useEffect 处理 pendingPanel
  useEffect(() => {
    if (pageState.inWorkspace && pageState.pendingPanel && taskViewRef.current) {
      taskViewRef.current.addPanel(pageState.pendingPanel);
      pageHandlers.setPendingPanel(null);
    }
  }, [pageState.inWorkspace, pageState.pendingPanel, pageHandlers]);

  // Handle new task creation (Zen-only)
  const handleCreateTask = useCallback(
    async (name: string, targetBranch: string, notes: string) => {
      if (!selectedProject) return;
      try {
        setIsCreating(true);
        setCreateError(null);

        // Create task and get the response
        const taskResponse = await apiCreateTask(selectedProject.id, name, targetBranch, notes || undefined);

        setShowNewTaskDialog(false);

        // Auto-select the new task and enter Workspace (default panel chosen by FlexLayoutContainer)
        const newTask = convertTaskResponse(taskResponse);
        pageHandlers.setSelectedTask(newTask);
        pageHandlers.setInWorkspace(true);

        // 🚀 优化: 异步刷新,不阻塞 UI
        refreshSelectedProject();
      } catch (err: unknown) {
        console.error("Failed to create task:", err);
        if (err && typeof err === "object" && "status" in err) {
          const apiErr = err as { status: number; message: string };
          if (apiErr.status === 400) {
            setCreateError("Invalid task name or target branch");
          } else {
            setCreateError("Failed to create task");
          }
        } else {
          setCreateError("Failed to create task");
        }
      } finally {
        setIsCreating(false);
      }
    },
    [selectedProject, refreshSelectedProject, pageHandlers]
  );

  // Deprecated - page is no longer in use
  // const handleStartSession = useCallback(() => {
  //   pageHandlers.setViewMode("terminal");
  // }, [pageHandlers]);

  // // Handle terminal connected - refresh to update task status to "live"
  // const handleTerminalConnected = useCallback(async () => {
  //   await refreshSelectedProject();
  //   setAutoStartSession(false);
  // }, [refreshSelectedProject]);

  // // Handle terminal disconnected - refresh to update task status to "idle"
  // const handleTerminalDisconnected = useCallback(async () => {
  //   await refreshSelectedProject();
  // }, [refreshSelectedProject]);

  // Task navigation hook
  const navHandlers = useTaskNavigation({
    tasks: filteredTasks,
    selectedTask: pageState.selectedTask,
    inWorkspace: pageState.inWorkspace,
    onSelectTask: handleSelectTask,
    setContextMenu: pageHandlers.setContextMenu,
  });

  const hasTask = !!pageState.selectedTask;
  const isActive = hasTask && pageState.selectedTask!.status !== "archived";
  const isArchived = hasTask && pageState.selectedTask!.status === "archived";
  const canOperate = isActive && pageState.selectedTask!.status !== "broken";
  const notInWorkspace = !pageState.inWorkspace;

  // --- Register all hotkeys ---
  useHotkeys(
    [
      // Navigation
      { key: "j", handler: navHandlers.selectNextTask, options: { enabled: notInWorkspace } },
      { key: "ArrowDown", handler: navHandlers.selectNextTask, options: { enabled: notInWorkspace } },
      { key: "k", handler: navHandlers.selectPreviousTask, options: { enabled: notInWorkspace } },
      { key: "ArrowUp", handler: navHandlers.selectPreviousTask, options: { enabled: notInWorkspace } },
      {
        key: "Enter",
        handler: () => {
          if (!pageState.inWorkspace && pageState.selectedTask && pageState.selectedTask.status !== "archived") {
            pageHandlers.handleEnterWorkspace();
          }
        },
        options: { enabled: notInWorkspace && hasTask },
      },
      {
        key: "Escape",
        handler: pageHandlers.handleCloseTask,
        options: { enabled: pageState.inWorkspace || hasTask },
      },

      // Info panel tabs (only in Task List page, not in Workspace)
      { key: "1", handler: () => pageHandlers.setInfoPanelTab("stats"), options: { enabled: notInWorkspace && hasTask } },
      { key: "2", handler: () => pageHandlers.setInfoPanelTab("git"), options: { enabled: notInWorkspace && hasTask } },
      { key: "3", handler: () => pageHandlers.setInfoPanelTab("notes"), options: { enabled: notInWorkspace && hasTask } },
      { key: "4", handler: () => pageHandlers.setInfoPanelTab("comments"), options: { enabled: notInWorkspace && hasTask } },

      // Actions (work in all modes; xterm focus auto-suppresses via useHotkeys)
      { key: "n", handler: () => setShowNewTaskDialog(true) },
      { key: "Space", handler: navHandlers.openContextMenuAtSelectedTask, options: { enabled: hasTask && notInWorkspace } },
      { key: "c", handler: opsHandlers.handleCommit, options: { enabled: isActive } },
      { key: "s", handler: opsHandlers.handleSync, options: { enabled: canOperate } },
      { key: "m", handler: opsHandlers.handleMerge, options: { enabled: canOperate } },
      { key: "b", handler: opsHandlers.handleRebase, options: { enabled: canOperate } },

      // Search
      {
        key: "/",
        handler: () => searchInputRef.current?.focus(),
        options: { enabled: notInWorkspace },
      },

      // Help
      { key: "?", handler: () => pageHandlers.setShowHelp(!pageState.showHelp) },
    ],
    [
      navHandlers, pageHandlers, opsHandlers,
      pageState.inWorkspace, pageState.selectedTask, hasTask, isActive, isArchived, canOperate, notInWorkspace,
    ]
  );

  // If no project selected
  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--color-text-muted)]">
          Select a project to view tasks
        </p>
      </div>
    );
  }

  // Build context menu items using utility function
  const contextMenuItems = pageState.contextMenu
    ? buildContextMenuItems(pageState.contextMenu.task, {
        onEnterTerminal: () => handleDoubleClickTask(pageState.contextMenu!.task),
        onCommit: opsHandlers.handleCommit,
        onRebase: opsHandlers.handleRebase,
        onSync: opsHandlers.handleSync,
        onMerge: opsHandlers.handleMerge,
        onArchive: opsHandlers.handleArchive,
        onReset: opsHandlers.handleReset,
        onClean: opsHandlers.handleClean,
        onRecover: pageState.contextMenu.task.status === "archived" ? handleRecover : undefined,
      } as TaskOperationHandlers)
    : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-[calc(100vh-48px)] flex flex-col"
    >
      {/* Header - hidden in fullscreen */}
      {!isFullscreen && (
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Tasks</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => pageHandlers.setShowHelp(true)}
              className="px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded-md transition-colors"
              title="Keyboard Shortcuts (?)"
            >
              <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg)] border-[var(--color-border)]">?</kbd>
            </button>
            <Button onClick={() => setShowNewTaskDialog(true)} size="sm">
              <Plus className="w-4 h-4 mr-1.5" />
              New Task
            </Button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 relative overflow-hidden">
        {/* Task List Page: Task List + Info Panel side by side */}
        <motion.div
          animate={{
            opacity: pageState.inWorkspace ? 0 : 1,
            x: pageState.inWorkspace ? -20 : 0,
          }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className={`absolute inset-0 flex gap-4 ${pageState.inWorkspace ? "pointer-events-none" : ""}`}
        >
          {/* Task Sidebar */}
          <div className="w-72 flex-shrink-0 h-full">
            <TaskSidebar
              tasks={filteredTasks}
              selectedTask={pageState.selectedTask}
              filter={filter}
              searchQuery={pageState.searchQuery}
              isLoading={filter === "archived" && isLoadingArchived}
              searchInputRef={searchInputRef}
              onSelectTask={handleSelectTask}
              onDoubleClickTask={handleDoubleClickTask}
              onContextMenuTask={pageHandlers.handleContextMenu}
              onFilterChange={setFilter}
              onSearchChange={pageHandlers.setSearchQuery}
            />
          </div>

          {/* Right Panel: Empty State or Info Panel */}
          <div className="flex-1 h-full">
            <AnimatePresence mode="wait">
              {!pageState.inWorkspace && pageState.selectedTask ? (
                <motion.div
                  key="info-panel"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ type: "spring", damping: 25, stiffness: 200 }}
                  className="h-full"
                >
                  <TaskInfoPanel
                    projectId={selectedProject.id}
                    task={pageState.selectedTask}
                    projectName={selectedProject.name}
                    onClose={pageHandlers.handleCloseTask}
                    onEnterWorkspace={pageState.selectedTask.status !== "archived" ? pageHandlers.handleEnterWorkspace : undefined}
                    onAddPanel={pageState.selectedTask.status !== "archived" ? handleAddPanelFromInfo : undefined}
                    onRecover={pageState.selectedTask.status === "archived" ? handleRecover : undefined}
                    onClean={opsHandlers.handleClean}
                    onCommit={pageState.selectedTask.status !== "archived" ? opsHandlers.handleCommit : undefined}
                    onRebase={pageState.selectedTask.status !== "archived" ? opsHandlers.handleRebase : undefined}
                    onSync={pageState.selectedTask.status !== "archived" ? opsHandlers.handleSync : undefined}
                    onMerge={pageState.selectedTask.status !== "archived" ? opsHandlers.handleMerge : undefined}
                    onArchive={pageState.selectedTask.status !== "archived" ? opsHandlers.handleArchive : undefined}
                    onReset={pageState.selectedTask.status !== "archived" ? opsHandlers.handleReset : undefined}
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
          </div>
        </motion.div>

        {/* Workspace Page: Info Panel + TaskView */}
        <AnimatePresence>
          {pageState.inWorkspace && pageState.selectedTask && (
            <motion.div
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="absolute inset-0 flex gap-3"
            >
              {/* Info Panel (collapsible vertical bar in Workspace) - hidden in fullscreen */}
              {!isFullscreen && (
                <TaskInfoPanel
                  projectId={selectedProject.id}
                  task={pageState.selectedTask}
                  projectName={selectedProject.name}
                  onClose={pageHandlers.handleCloseTask}
                  isTerminalMode
                  onAddPanel={handleAddPanel}
                />
              )}

              <TaskView
                ref={taskViewRef}
                projectId={selectedProject.id}
                task={pageState.selectedTask}
                projectName={selectedProject.name}
                fullscreen={isFullscreen}
                onFullscreenChange={setIsFullscreen}
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

      {/* Operation Message Toast */}
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

      {/* New Task Dialog */}
      <NewTaskDialog
        isOpen={showNewTaskDialog}
        onClose={() => {
          setShowNewTaskDialog(false);
          setCreateError(null);
        }}
        onCreate={handleCreateTask}
        isLoading={isCreating}
        externalError={createError}
      />

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
        taskName={pageState.selectedTask?.name || ""}
        branchName={pageState.selectedTask?.branch || ""}
        targetBranch={pageState.selectedTask?.target || ""}
        isLoading={opsState.isMerging}
        error={opsState.mergeError}
        onMerge={opsHandlers.handleMergeSubmit}
        onCancel={opsHandlers.handleMergeCancel}
      />

      {/* Clean Confirm Dialog */}
      <ConfirmDialog
        isOpen={opsState.showCleanConfirm}
        title="Delete Task"
        message={`Are you sure you want to delete "${pageState.selectedTask?.name}"? This will remove the worktree and all associated data. This action cannot be undone.`}
        confirmLabel={opsState.isDeleting ? "Deleting..." : "Delete"}
        variant="danger"
        onConfirm={opsHandlers.handleCleanConfirm}
        onCancel={opsHandlers.handleCleanCancel}
      />

      {/* Archive after Merge Confirm Dialog (TUI: ConfirmType::MergeSuccess) */}
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

      {/* Archive Confirm Dialog (API preflight) */}
      <ConfirmDialog
        isOpen={!!pendingArchiveConfirm}
        title="Archive"
        message={pendingArchiveConfirm?.message || ""}
        variant="warning"
        onConfirm={() => opsHandlers.handleArchiveConfirm(pendingArchiveConfirm)}
        onCancel={() => opsHandlers.handleArchiveCancel(pendingArchiveConfirm)}
      />

      {/* Reset Confirm Dialog (TUI: ConfirmType::Reset) */}
      <ConfirmDialog
        isOpen={opsState.showResetConfirm}
        title="Reset Task"
        message={`Are you sure you want to reset "${pageState.selectedTask?.name}"? This will discard all changes and recreate the worktree from ${pageState.selectedTask?.target}. This action cannot be undone.`}
        confirmLabel={opsState.isResetting ? "Resetting..." : "Reset"}
        variant="danger"
        onConfirm={opsHandlers.handleResetConfirm}
        onCancel={opsHandlers.handleResetCancel}
      />

      {/* Rebase Dialog (Change Target Branch) */}
      <RebaseDialog
        isOpen={opsState.showRebaseDialog}
        taskName={pageState.selectedTask?.name}
        currentTarget={pageState.selectedTask?.target || ""}
        availableBranches={opsState.availableBranches}
        onClose={opsHandlers.handleRebaseCancel}
        onRebase={opsHandlers.handleRebaseSubmit}
      />

      {/* Task Context Menu */}
      <ContextMenu
        items={contextMenuItems}
        position={pageState.contextMenu?.position ?? null}
        onClose={pageHandlers.closeContextMenu}
      />

      {/* Help Overlay */}
      <HelpOverlay isOpen={pageState.showHelp} onClose={() => pageHandlers.setShowHelp(false)} />
    </motion.div>
  );
}
