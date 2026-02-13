import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus } from "lucide-react";
import { TaskSidebar } from "./TaskSidebar/TaskSidebar";
import { TaskInfoPanel } from "./TaskInfoPanel";
import { TaskView } from "./TaskView";
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

type ViewMode = "list" | "info" | "terminal";

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
  const [autoStartSession, setAutoStartSession] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

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
      pageHandlers.setViewMode("list");
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
      pageHandlers.setViewMode("list");
    },
    onTaskMerged: (taskId, taskName) => {
      postMergeHandlers.triggerPostMergeArchive(taskId, taskName);
    },
    setPendingArchiveConfirm,
  });

  // Load archived tasks when filter changes to "archived"
  // Also filter by current branch
  useEffect(() => {
    if (filter === "archived" && selectedProject) {
      setIsLoadingArchived(true);
      const currentBranch = selectedProject.currentBranch || "main";
      apiListTasks(selectedProject.id, "archived")
        .then((tasks) => {
          const filtered = tasks
            .map(convertTaskResponse)
            .filter((t) => t.target === currentBranch);
          setArchivedTasks(filtered);
        })
        .catch((err) => {
          console.error("Failed to load archived tasks:", err);
        })
        .finally(() => {
          setIsLoadingArchived(false);
        });
    }
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
        const targetMode = (initialViewMode === "terminal" || initialViewMode === "info") ? initialViewMode : "info";
        pageHandlers.setViewMode(targetMode as ViewMode);
        // Consume the navigation data so it doesn't re-trigger
        onNavigationConsumed?.();
      }
    }
  }, [initialTaskId, initialViewMode, activeTasks, pageState.selectedTask, onNavigationConsumed, pageHandlers]);

  // Filter and search tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
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
    setAutoStartSession(false);
    pageHandlers.handleSelectTask(task);
  }, [pageHandlers]);

  const handleDoubleClickTask = useCallback((task: Task) => {
    setAutoStartSession(false);
    pageHandlers.handleDoubleClickTask(task);
  }, [pageHandlers]);

  // Handle recover archived task (Zen-only)
  const handleRecover = useCallback(async () => {
    if (!selectedProject || !pageState.selectedTask) return;
    try {
      await apiRecoverTask(selectedProject.id, pageState.selectedTask.id);
      await refreshSelectedProject();
      // Clear archived tasks cache so it reloads
      setArchivedTasks((prev) => prev.filter((t) => t.id === pageState.selectedTask?.id));
      // Update local state to reflect the change
      pageHandlers.setSelectedTask(null);
      pageHandlers.setViewMode("list");
      // Switch to active filter to see the recovered task
      setFilter("active");
    } catch (err) {
      console.error("Failed to recover task:", err);
      const errorMessage = err instanceof Error ? err.message :
        (err as { message?: string })?.message || "Failed to recover task";
      pageHandlers.showMessage(errorMessage);
    }
  }, [selectedProject, pageState.selectedTask, refreshSelectedProject, pageHandlers]);

  // Handle new task creation (Zen-only)
  const handleCreateTask = useCallback(
    async (name: string, targetBranch: string, notes: string) => {
      if (!selectedProject) return;
      try {
        setIsCreating(true);
        setCreateError(null);
        // Create task and get the response
        const taskResponse = await apiCreateTask(selectedProject.id, name, targetBranch, notes || undefined);
        await refreshSelectedProject();
        setShowNewTaskDialog(false);

        // Auto-select the new task and enter terminal mode with auto-start
        const newTask = convertTaskResponse(taskResponse);
        pageHandlers.setSelectedTask(newTask);
        setAutoStartSession(true);
        pageHandlers.setViewMode("terminal");
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

  const handleStartSession = useCallback(() => {
    pageHandlers.setViewMode("terminal");
  }, [pageHandlers]);

  // Handle terminal connected - refresh to update task status to "live"
  const handleTerminalConnected = useCallback(async () => {
    await refreshSelectedProject();
    setAutoStartSession(false);
  }, [refreshSelectedProject]);

  // Task navigation hook
  const navHandlers = useTaskNavigation({
    tasks: filteredTasks,
    selectedTask: pageState.selectedTask,
    viewMode: pageState.viewMode,
    onSelectTask: handleSelectTask,
    setViewMode: pageHandlers.setViewMode,
    setContextMenu: pageHandlers.setContextMenu,
  });

  const hasTask = !!pageState.selectedTask;
  const isActive = hasTask && pageState.selectedTask!.status !== "archived";
  const isArchived = hasTask && pageState.selectedTask!.status === "archived";
  const canOperate = isActive && pageState.selectedTask!.status !== "broken";
  const notTerminal = pageState.viewMode !== "terminal";

  // --- Register all hotkeys ---
  useHotkeys(
    [
      // Navigation
      { key: "j", handler: navHandlers.selectNextTask, options: { enabled: notTerminal } },
      { key: "ArrowDown", handler: navHandlers.selectNextTask, options: { enabled: notTerminal } },
      { key: "k", handler: navHandlers.selectPreviousTask, options: { enabled: notTerminal } },
      { key: "ArrowUp", handler: navHandlers.selectPreviousTask, options: { enabled: notTerminal } },
      {
        key: "Enter",
        handler: () => {
          if (pageState.viewMode === "info" && pageState.selectedTask && pageState.selectedTask.status !== "archived") {
            pageHandlers.handleEnterTerminal();
          } else if (pageState.viewMode === "list" && pageState.selectedTask) {
            pageHandlers.setViewMode("info");
          }
        },
        options: { enabled: notTerminal && hasTask },
      },
      {
        key: "Escape",
        handler: pageHandlers.handleCloseTask,
        options: { enabled: pageState.viewMode !== "list" },
      },

      // Info panel tabs
      { key: "1", handler: () => pageHandlers.setInfoPanelTab("stats"), options: { enabled: notTerminal && hasTask } },
      { key: "2", handler: () => pageHandlers.setInfoPanelTab("git"), options: { enabled: notTerminal && hasTask } },
      { key: "3", handler: () => pageHandlers.setInfoPanelTab("notes"), options: { enabled: notTerminal && hasTask } },
      { key: "4", handler: () => pageHandlers.setInfoPanelTab("comments"), options: { enabled: notTerminal && hasTask } },

      // Actions (work in all modes; xterm focus auto-suppresses via useHotkeys)
      { key: "n", handler: () => setShowNewTaskDialog(true) },
      { key: "Space", handler: navHandlers.openContextMenuAtSelectedTask, options: { enabled: hasTask && notTerminal } },
      { key: "c", handler: opsHandlers.handleCommit, options: { enabled: isActive } },
      { key: "s", handler: opsHandlers.handleSync, options: { enabled: canOperate } },
      { key: "m", handler: opsHandlers.handleMerge, options: { enabled: canOperate } },
      { key: "b", handler: opsHandlers.handleRebase, options: { enabled: canOperate } },
      { key: "r", handler: pageHandlers.handleReviewShortcut, options: { enabled: isActive } },
      { key: "e", handler: pageHandlers.handleEditorShortcut, options: { enabled: isActive } },
      { key: "t", handler: pageHandlers.handleTerminalShortcut, options: { enabled: isActive } },

      // Search
      {
        key: "/",
        handler: () => searchInputRef.current?.focus(),
        options: { enabled: notTerminal },
      },

      // Help
      { key: "?", handler: () => pageHandlers.setShowHelp(!pageState.showHelp) },
    ],
    [
      navHandlers, pageHandlers, opsHandlers,
      pageState.viewMode, pageState.selectedTask, hasTask, isActive, isArchived, canOperate, notTerminal,
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

  const isTerminalMode = pageState.viewMode === "terminal";
  const isInfoMode = pageState.viewMode === "info";

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
      {/* Header */}
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

      {/* Main Content */}
      <div className="flex-1 relative overflow-hidden">
        {/* List Mode & Info Mode: Task List + Info Panel side by side */}
        <motion.div
          animate={{
            opacity: isTerminalMode ? 0 : 1,
            x: isTerminalMode ? -20 : 0,
          }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className={`absolute inset-0 flex gap-4 ${isTerminalMode ? "pointer-events-none" : ""}`}
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
              {isInfoMode && pageState.selectedTask ? (
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
                    onEnterTerminal={pageState.selectedTask.status !== "archived" ? pageHandlers.handleEnterTerminal : undefined}
                    onRecover={pageState.selectedTask.status === "archived" ? handleRecover : undefined}
                    onClean={opsHandlers.handleClean}
                    onCommit={pageState.selectedTask.status !== "archived" ? opsHandlers.handleCommit : undefined}
                    onReview={pageState.selectedTask.status !== "archived" ? pageHandlers.handleReviewFromInfo : undefined}
                    onEditor={pageState.selectedTask.status !== "archived" ? pageHandlers.handleEditorFromInfo : undefined}
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

        {/* Terminal Mode: Info Panel + TaskView */}
        <AnimatePresence>
          {isTerminalMode && pageState.selectedTask && (
            <motion.div
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="absolute inset-0 flex gap-3"
            >
              {/* Info Panel (collapsible vertical bar in terminal mode) */}
              <TaskInfoPanel
                projectId={selectedProject.id}
                task={pageState.selectedTask}
                projectName={selectedProject.name}
                onClose={pageHandlers.handleCloseTask}
                isTerminalMode
              />

              {/* TaskView (Terminal + optional Code Review / Editor) */}
              <TaskView
                projectId={selectedProject.id}
                task={pageState.selectedTask}
                projectName={selectedProject.name}
                reviewOpen={pageState.reviewOpen}
                editorOpen={pageState.editorOpen}
                autoStartSession={autoStartSession}
                onToggleReview={pageHandlers.handleToggleReview}
                onToggleEditor={pageHandlers.handleToggleEditor}
                onCommit={opsHandlers.handleCommit}
                onRebase={opsHandlers.handleRebase}
                onSync={opsHandlers.handleSync}
                onMerge={opsHandlers.handleMerge}
                onArchive={opsHandlers.handleArchive}
                onClean={opsHandlers.handleClean}
                onReset={opsHandlers.handleReset}
                onStartSession={handleStartSession}
                onTerminalConnected={handleTerminalConnected}
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
