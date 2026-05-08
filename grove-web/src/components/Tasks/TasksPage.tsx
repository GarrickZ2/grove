import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, ArrowLeft, GitBranch } from "lucide-react";
import { TaskSidebar } from "./TaskSidebar/TaskSidebar";
import { TaskInfoPanel } from "./TaskInfoPanel";
import { TaskView, type TaskViewHandle } from "./TaskView";
import { NewTaskDialog } from "./NewTaskDialog";
import { TaskOperationDialogs } from "./TaskOperationDialogs";
import { Button } from "../ui";
import { ContextMenu } from "../ui/ContextMenu";
import { useProject, useCommandPalette } from "../../context";
import { useReportDebugId } from "../../perf/debugIdsStore";
import {
  useIsMobile,
  useHotkeys,
  useTaskPageState,
  useTaskNavigation,
  usePostMergeArchive,
  useTaskOperations,
  buildCommands,
} from "../../hooks";
import {
  createTask as apiCreateTask,
  recoverTask as apiRecoverTask,
  listTasks as apiListTasks,
  initGitRepo,
} from "../../api";
import type { Task, TaskFilter } from "../../data/types";
import { convertTaskResponse } from "../../utils/taskConvert";
import type { PendingArchiveConfirm } from "../../utils/archiveHelpers";
import { buildContextMenuItems, type TaskOperationHandlers } from "../../utils/taskOperationUtils";
import type { PanelType } from "./PanelSystem/types";

interface TasksPageProps {
  /** Initial task ID to select (from navigation) */
  initialTaskId?: string;
  /** Initial chat ID to focus inside the selected task (from navigation —
   *  e.g. tray popover Open with a specific chat). TaskView consumption
   *  is a TODO: chat selection lives several layers below in the
   *  flex/IDE layout, not yet wired through this prop. */
  initialChatId?: string;
  /** Initial view mode to use (from navigation, e.g. "terminal") */
  initialViewMode?: string;
  /** Callback when navigation data has been consumed */
  onNavigationConsumed?: () => void;
  /** Fallback for Cmd+N navigation when workspace doesn't have a matching tab.
   *  Called with (index, false) for absolute or (delta, true) for relative. */
  onNavByIndex?: (indexOrDelta: number, relative?: boolean) => void;
  /** When true, opens the New Task dialog on mount */
  initialOpenNewTask?: boolean;
  /** Increment to signal TasksPage to exit the current workspace (e.g. when Tasks tab is re-clicked) */
  exitWorkspaceSignal?: number;
}

export function TasksPage({ initialTaskId, initialChatId, initialViewMode, onNavigationConsumed, onNavByIndex, initialOpenNewTask, exitWorkspaceSignal }: TasksPageProps) {
  const { selectedProject, refreshSelectedProject } = useProject();
  const prevProjectIdRef = useRef<string | undefined>(selectedProject?.id);
  const isStudio = selectedProject?.projectType === "studio";

  const { isMobile } = useIsMobile();

  // Zen-specific state
  const [filter, setFilter] = useState<TaskFilter>("active");
  // Mobile: whether the detail view is showing (stacked navigation)
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [showNewTaskDialog, setShowNewTaskDialog] = useState(initialOpenNewTask ?? false);
  useEffect(() => {
    if (initialOpenNewTask) {
      Promise.resolve().then(() => {
        setShowNewTaskDialog(true);
        onNavigationConsumed?.();
      });
    }
  }, [initialOpenNewTask, onNavigationConsumed]);
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
  useReportDebugId("taskId", pageState.selectedTask?.id ?? null);

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
      // Defer the "loading=true" flip into a microtask so the rule sees
      // setState as a callback rather than a synchronous in-effect call.
      Promise.resolve().then(() => { if (!cancelled) setIsLoadingArchived(true); });
      apiListTasks(selectedProject.id, "archived")
        .then((tasks) => {
          if (cancelled) return;
          const filtered = tasks
            .map(convertTaskResponse);
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

  // Get tasks for current project (combine active and archived).
  // Backend already excludes Local Task from the tasks array; Local Task has
  // its own dedicated WorkPage route.
  const activeTasks = (selectedProject?.tasks || []).filter(
    (t) => t.status !== "archived"
  );
  const tasks = filter === "archived" ? archivedTasks : activeTasks;

  // Handle initial task selection from navigation
  useEffect(() => {
    if (!initialTaskId || activeTasks.length === 0) return;

    const task = activeTasks.find((t) => t.id === initialTaskId);
    if (!task) return;

    if (pageState.selectedTask?.id !== task.id) {
      pageHandlers.setSelectedTask(task);
    }

    // If initialViewMode is "terminal", enter Workspace
    if (initialViewMode === "terminal") {
      pageHandlers.setInWorkspace(true);
    }

    // Navigate to the specific chat session if provided (tray deep-link).
    // Uses the same __grove_pending_chat + grove:switch-chat pattern as
    // BlitzPage so both the "workspace just mounted" and "already mounted"
    // cases are handled.
    if (initialChatId && selectedProject) {
      const projectId = selectedProject.id;
      const taskId = initialTaskId;
      const chatId = initialChatId;
      (window as unknown as Record<string, unknown>).__grove_pending_chat = {
        projectId,
        taskId,
        chatId,
      };
      window.dispatchEvent(
        new CustomEvent("grove:switch-chat", {
          detail: { projectId, taskId, chatId },
        }),
      );
    }

    // Consume the navigation data so it doesn't re-trigger
    onNavigationConsumed?.();
  }, [initialTaskId, initialChatId, initialViewMode, activeTasks, pageState.selectedTask?.id, onNavigationConsumed, pageHandlers, selectedProject]);

  // Exit workspace when Tasks tab is re-clicked (signal from App.tsx).
  // Use a ref for inWorkspace so the effect only fires on signal changes but
  // always reads the latest value — avoids a stale-closure without adding
  // inWorkspace as a dep (which would make every workspace-enter/exit fire it).
  const inWorkspaceRef = useRef(pageState.inWorkspace);
  useEffect(() => {
    inWorkspaceRef.current = pageState.inWorkspace;
  }, [pageState.inWorkspace]);
  useEffect(() => {
    if (!exitWorkspaceSignal) return;
    if (inWorkspaceRef.current) pageHandlers.handleCloseTask();
    // pageHandlers intentionally omitted: it's recreated every render, which
    // would re-fire this effect after re-entering Workspace and immediately
    // close it. handleCloseTask is useCallback-stable.
  }, [exitWorkspaceSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset workspace state when project changes (sidebar switch or notification navigation)
  useEffect(() => {
    if (prevProjectIdRef.current !== selectedProject?.id) {
      prevProjectIdRef.current = selectedProject?.id;
      pageHandlers.setInWorkspace(false);
      pageHandlers.setSelectedTask(null);
    }
  }, [selectedProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Auto-select first task when entering the page with no selection
  useEffect(() => {
    if (!pageState.selectedTask && !initialTaskId && filteredTasks.length > 0) {
      pageHandlers.setSelectedTask(filteredTasks[0]);
    }
  }, [pageState.selectedTask, initialTaskId, filteredTasks, pageHandlers]);

  // Wrap page handlers to handle auto-start state
  const handleSelectTask = useCallback((task: Task) => {
    pageHandlers.handleSelectTask(task);
    if (isMobile) {
      setMobileShowDetail(true);
    }
  }, [pageHandlers, isMobile]);

  const handleDoubleClickTask = useCallback((task: Task) => {
    pageHandlers.handleDoubleClickTask(task);
  }, [pageHandlers]);

  // Mobile: go back from detail to list
  const handleMobileBack = useCallback(() => {
    if (pageState.inWorkspace) {
      pageHandlers.handleCloseTask();
    } else {
      setMobileShowDetail(false);
    }
  }, [pageState.inWorkspace, pageHandlers]);

  // Handle recover archived task (Zen-only)
  const handleRecover = useCallback(async () => {
    if (!selectedProject || !pageState.selectedTask) return;
    const recoveredTaskId = pageState.selectedTask.id;
    let recoverErr: unknown = null;
    try {
      await apiRecoverTask(selectedProject.id, recoveredTaskId);
      await refreshSelectedProject();
    } catch (err) {
      recoverErr = err;
    }
    if (recoverErr !== null) {
      console.error("Failed to recover task:", recoverErr);
      let errorMessage: string;
      if (recoverErr instanceof Error) {
        errorMessage = recoverErr.message;
      } else {
        const maybeMsg = (recoverErr as { message?: string })?.message;
        errorMessage = maybeMsg ? maybeMsg : "Failed to recover task";
      }
      pageHandlers.showMessage(errorMessage);
      return;
    }
    // Clear archived tasks cache so it reloads
    setArchivedTasks((prev) => prev.filter((t) => t.id !== recoveredTaskId));
    // Update local state to reflect the change
    pageHandlers.setSelectedTask(null);
    pageHandlers.setInWorkspace(false);
    // Switch to active filter to see the recovered task
    setFilter("active");
  }, [selectedProject, pageState.selectedTask, refreshSelectedProject, pageHandlers]);

  // Unified panel add handler (Terminal/Chat/Review/Editor/Stats/Git/Notes/Comments)
  const handleAddPanel = useCallback((type: PanelType) => {
    // Call TaskView's addPanel method
    if (taskViewRef.current) {
      taskViewRef.current.addPanel(type);
    }
  }, []);

  // Handle adding panel from Info Panel (enter workspace + open panel)
  const handleAddPanelFromInfo = useCallback((type: PanelType) => {
    pageHandlers.setInWorkspace(true);
    pageHandlers.setPendingPanel(type);
  }, [pageHandlers]);

  // Process pendingPanel after entering workspace
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
      setIsCreating(true);
      setCreateError(null);
      const notesArg = notes ? notes : undefined;
      let taskResponse: Awaited<ReturnType<typeof apiCreateTask>> | null = null;
      let createErr: unknown = null;
      try {
        // Create task and get the response
        taskResponse = await apiCreateTask(selectedProject.id, name, targetBranch, notesArg);
      } catch (err: unknown) {
        createErr = err;
      }
      if (createErr !== null) {
        console.error("Failed to create task:", createErr);
        if (createErr && typeof createErr === "object" && "message" in createErr) {
          const apiErr = createErr as { message: string };
          const msg = apiErr.message ? apiErr.message : "Failed to create task";
          setCreateError(msg);
        } else {
          setCreateError("Failed to create task");
        }
        setIsCreating(false);
        return;
      }
      if (taskResponse) {
        setShowNewTaskDialog(false);
        // Auto-select the new task and enter Workspace (default panel chosen by FlexLayoutContainer)
        const newTask = convertTaskResponse(taskResponse);
        pageHandlers.setSelectedTask(newTask);
        pageHandlers.setInWorkspace(true);
        // Async refresh, don't block UI
        refreshSelectedProject();
      }
      setIsCreating(false);
    },
    [selectedProject, refreshSelectedProject, pageHandlers]
  );

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
  const canOperate = isActive;
  const notInWorkspace = !pageState.inWorkspace;

  // Workspace keyboard shortcuts (higher priority than App-level)
  // Cmd+1-9: switch panel tabs, Cmd+W / Alt+W: close active tab
  useEffect(() => {
    if (!pageState.inWorkspace) return;
    const isTauri = !!((window as Window & { __TAURI__?: unknown }).__TAURI__);
    const handler = (e: KeyboardEvent) => {
      // Cmd+1-9: switch panel tabs.
      // Fallback to sidebar navigation only when workspace has no tabs.
      // When tabs exist but index is out of range, do nothing (user intended a tab switch).
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
        const index = parseInt(e.key) - 1;
        const result = taskViewRef.current?.selectTabByIndex(index) ?? "no_tabs";
        if (result === "handled") {
          e.preventDefault();
          e.stopImmediatePropagation();
        } else if (result === "no_tabs" && onNavByIndex) {
          e.preventDefault();
          e.stopImmediatePropagation();
          onNavByIndex(index);
        }
        // "out_of_range": tabs exist but index exceeds count — do nothing
        return;
      }
      // Cmd+Shift+[/]: switch workspace tabs
      if (e.metaKey && e.shiftKey && !e.altKey && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const delta = e.key === "]" ? 1 : -1;
        taskViewRef.current?.selectAdjacentTab(delta);
        return;
      }
      // Option+Cmd+Up/Down: switch sidebar nav items
      if (e.metaKey && e.altKey && (e.code === "ArrowUp" || e.code === "ArrowDown")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (onNavByIndex) {
          onNavByIndex(e.code === "ArrowDown" ? 1 : -1, true);
        }
        return;
      }
      // Close active tab: Cmd+W (Tauri) or Alt+W (web)
      // Note: macOS Alt produces special chars (e.g. Alt+W → ∑), so use e.code
      const isCloseTab = (isTauri && e.metaKey && e.code === "KeyW")
        || (e.altKey && !e.metaKey && e.code === "KeyW");
      if (isCloseTab) {
        e.preventDefault();
        e.stopImmediatePropagation();
        taskViewRef.current?.closeActiveTab();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [pageState.inWorkspace, onNavByIndex]);

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
      // Panel shortcuts in the task-LIST view: enter workspace + open panel.
      // The in-workspace versions (and the git ops c/s/m/b/a/x/Shift+x) are
      // owned by TaskView itself, which is where the workspace lives — that
      // way every host (Tasks / Blitz / Work) gets the same behavior with
      // one registration instead of three copies drifting apart.
      { key: "r", handler: () => handleAddPanelFromInfo("review"), options: { enabled: hasTask && isActive && notInWorkspace } },
      { key: "e", handler: () => handleAddPanelFromInfo("editor"), options: { enabled: hasTask && isActive && notInWorkspace } },
      { key: "i", handler: () => handleAddPanelFromInfo("chat"), options: { enabled: hasTask && isActive && notInWorkspace } },
      { key: "t", handler: () => handleAddPanelFromInfo("terminal"), options: { enabled: hasTask && isActive && notInWorkspace } },

      // Search
      {
        key: "/",
        handler: () => searchInputRef.current?.focus(),
        options: { enabled: notInWorkspace },
      },

    ],
    [
      navHandlers, pageHandlers, opsHandlers, handleAddPanel, handleAddPanelFromInfo, refreshSelectedProject,
      pageState.inWorkspace, pageState.selectedTask, hasTask, isActive, isArchived, canOperate, notInWorkspace,
    ]
  );

  // Register page-level commands for Cmd+K command palette
  const {
    registerPageCommands,
    unregisterPageCommands,
    setInWorkspace: setContextInWorkspace,
    setPageContext,
  } = useCommandPalette();

  // Sync inWorkspace to context so App can disable Cmd+1-4 sidebar switching
  useEffect(() => {
    setContextInWorkspace(pageState.inWorkspace);
    setPageContext(pageState.inWorkspace ? "workspace" : "tasks");
    return () => {
      setContextInWorkspace(false);
      setPageContext("default");
    };
  }, [pageState.inWorkspace, setContextInWorkspace, setPageContext]);
  const pageOptionsRef = useRef<Parameters<typeof buildCommands>[0]>(null!);
  // Build the latest options object during render (no setState/ref-write
  // side effect), then commit it into the ref in an effect.
  const pageOptions: Parameters<typeof buildCommands>[0] = {
    taskActions: {
      selectedTask: pageState.selectedTask,
      inWorkspace: pageState.inWorkspace,
      opsHandlers,
      onEnterWorkspace: pageHandlers.handleEnterWorkspace,
      onOpenPanel: (panel) => handleAddPanelFromInfo(panel as PanelType),
      onSwitchInfoTab: pageHandlers.setInfoPanelTab,
      onRefresh: refreshSelectedProject,
      onNewTask: () => setShowNewTaskDialog(true),
      isStudio,
    },
  };
  useEffect(() => {
    pageOptionsRef.current = pageOptions;
  });

  useEffect(() => {
    registerPageCommands(() => buildCommands(pageOptionsRef.current));
    return () => unregisterPageCommands();
  }, [registerPageCommands, unregisterPageCommands]);

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

  // Non-git project: Tasks require git worktrees, show init prompt (skip for Studio).
  if (!selectedProject.isGitRepo && !isStudio) {
    return <NonGitTasksEmptyState projectId={selectedProject.id} onRefresh={refreshSelectedProject} />;
  }

  // Build context menu items using utility function
  const contextMenuItems = pageState.contextMenu
    ? buildContextMenuItems(pageState.contextMenu.task, {
        onEnterTerminal: () => handleDoubleClickTask(pageState.contextMenu!.task),
        onCommit: isStudio ? undefined : opsHandlers.handleCommit,
        onRebase: isStudio ? undefined : opsHandlers.handleRebase,
        onSync: isStudio ? undefined : opsHandlers.handleSync,
        onMerge: isStudio ? undefined : opsHandlers.handleMerge,
        onArchive: opsHandlers.handleArchive,
        onReset: isStudio ? undefined : opsHandlers.handleReset,
        onClean: opsHandlers.handleClean,
        onRecover: pageState.contextMenu.task.status === "archived" ? handleRecover : undefined,
      } as TaskOperationHandlers)
    : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-full flex flex-col"
    >
      {/* Header - hidden in fullscreen and workspace */}
      {!isFullscreen && !pageState.inWorkspace && (
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          {isMobile && mobileShowDetail ? (
            <button
              onClick={handleMobileBack}
              className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          ) : (
            <h1 className="text-xl font-semibold text-[var(--color-text)] select-none">Tasks</h1>
          )}
          <div className="flex items-center gap-2">
            {!isMobile && (
              <button
                onClick={() => pageHandlers.setShowHelp(true)}
                className="px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded-md transition-colors"
                title="Keyboard Shortcuts (?)"
              >
                <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg)] border-[var(--color-border)]">?</kbd>
              </button>
            )}
            {!(isMobile && mobileShowDetail) && (
              <Button onClick={() => setShowNewTaskDialog(true)} size="sm">
                <Plus className="w-4 h-4 mr-1.5" />
                New Task
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 relative overflow-hidden">
        {isMobile ? (
          /* Mobile: Stacked navigation */
          <AnimatePresence initial={false}>
            {mobileShowDetail && pageState.selectedTask ? (
              <motion.div
                key="mobile-detail"
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", damping: 30, stiffness: 300 }}
                className="absolute inset-0"
              >
                {pageState.inWorkspace ? (
                  <div className="h-full flex flex-col">
                    <TaskView
                      ref={taskViewRef}
                      projectId={selectedProject.id}
                      task={pageState.selectedTask}
                      projectName={selectedProject.name}
                      fullscreen={isFullscreen}
                      onFullscreenChange={setIsFullscreen}
                      onBack={handleMobileBack}
                      onCommit={isStudio ? undefined : opsHandlers.handleCommit}
                      onRebase={isStudio ? undefined : opsHandlers.handleRebase}
                      onSync={isStudio ? undefined : opsHandlers.handleSync}
                      onMerge={isStudio ? undefined : opsHandlers.handleMerge}
                      onArchive={opsHandlers.handleArchive}
                      onClean={opsHandlers.handleClean}
                      onReset={isStudio ? undefined : opsHandlers.handleReset}
                    />
                  </div>
                ) : (
                  <TaskInfoPanel
                    projectId={selectedProject.id}
                    task={pageState.selectedTask}
                    projectName={selectedProject.name}
                    onClose={handleMobileBack}
                    onEnterWorkspace={pageState.selectedTask.status !== "archived" ? pageHandlers.handleEnterWorkspace : undefined}
                    onAddPanel={pageState.selectedTask.status !== "archived" ? handleAddPanelFromInfo : undefined}
                    onRecover={pageState.selectedTask.status === "archived" ? handleRecover : undefined}
                    onClean={opsHandlers.handleClean}
                    onCommit={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleCommit : undefined}
                    onRebase={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleRebase : undefined}
                    onSync={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleSync : undefined}
                    onMerge={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleMerge : undefined}
                    onArchive={pageState.selectedTask.status !== "archived" ? opsHandlers.handleArchive : undefined}
                    onReset={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleReset : undefined}
                    activeTab={pageState.infoPanelTab}
                    onTabChange={pageHandlers.setInfoPanelTab}
                  />
                )}
              </motion.div>
            ) : (
              <motion.div
                key="mobile-list"
                initial={{ opacity: 1 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0"
              >
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
                  onFilterChange={(f) => { setFilter(f); pageHandlers.setSelectedTask(null); pageHandlers.setInWorkspace(false); }}
                  onSearchChange={pageHandlers.setSearchQuery}
                  fullWidth
                />
              </motion.div>
            )}
          </AnimatePresence>
        ) : (
          /* Desktop: Side-by-side layout */
          <>
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
                  onFilterChange={(f) => { setFilter(f); pageHandlers.setSelectedTask(null); pageHandlers.setInWorkspace(false); }}
                  onSearchChange={pageHandlers.setSearchQuery}
                />
              </div>

              {/* Right Panel: Empty State or Info Panel */}
              <div className="flex-1 h-full min-w-0">
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
                        onCommit={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleCommit : undefined}
                        onRebase={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleRebase : undefined}
                        onSync={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleSync : undefined}
                        onMerge={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleMerge : undefined}
                        onArchive={pageState.selectedTask.status !== "archived" ? opsHandlers.handleArchive : undefined}
                        onReset={!isStudio && pageState.selectedTask.status !== "archived" ? opsHandlers.handleReset : undefined}
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
            <AnimatePresence mode="popLayout">
              {pageState.inWorkspace && pageState.selectedTask && (
                <motion.div
                  key={pageState.selectedTask.id}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.35, ease: [0.25, 1, 0.5, 1] }}
                  className="absolute inset-0 flex gap-1"
                >
                  <TaskView
                    ref={taskViewRef}
                    projectId={selectedProject.id}
                    task={pageState.selectedTask}
                    projectName={selectedProject.name}
                    fullscreen={isFullscreen}
                    onFullscreenChange={setIsFullscreen}
                    onBack={pageHandlers.handleCloseTask}
                    onCommit={isStudio ? undefined : opsHandlers.handleCommit}
                    onRebase={isStudio ? undefined : opsHandlers.handleRebase}
                    onSync={isStudio ? undefined : opsHandlers.handleSync}
                    onMerge={isStudio ? undefined : opsHandlers.handleMerge}
                    onArchive={opsHandlers.handleArchive}
                    onClean={opsHandlers.handleClean}
                    onReset={isStudio ? undefined : opsHandlers.handleReset}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
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

      {/* Shared operation dialogs (Commit / Merge / Clean / Reset / Rebase / Archive / PostMerge / DirtyBranch) */}
      <TaskOperationDialogs
        task={pageState.selectedTask}
        opsState={opsState}
        opsHandlers={opsHandlers}
        postMergeState={postMergeState}
        postMergeHandlers={postMergeHandlers}
        pendingArchiveConfirm={pendingArchiveConfirm}
      />

      {/* Task Context Menu */}
      <ContextMenu
        items={contextMenuItems}
        position={pageState.contextMenu?.position ?? null}
        onClose={pageHandlers.closeContextMenu}
      />

    </motion.div>
  );
}

/**
 * Empty state shown on the Tasks page when the project is not a Git repository.
 * Tasks require git worktrees, so the page prompts the user to initialize git.
 */
function NonGitTasksEmptyState({
  projectId,
  onRefresh,
}: {
  projectId: string;
  onRefresh: () => Promise<void>;
}) {
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInit = async () => {
    setIsInitializing(true);
    setError(null);
    let initErr: unknown = null;
    try {
      await initGitRepo(projectId);
      await onRefresh();
    } catch (err: unknown) {
      initErr = err;
    }
    if (initErr !== null) {
      if (initErr && typeof initErr === "object" && "message" in initErr) {
        const m = (initErr as { message: string }).message;
        setError(m ? m : "Failed to initialize Git");
      } else {
        setError("Failed to initialize Git");
      }
    }
    setIsInitializing(false);
  };

  return (
    <div className="flex items-center justify-center h-full px-6">
      <div className="max-w-md w-full text-center">
        <div className="mx-auto mb-6 w-16 h-16 rounded-full bg-[var(--color-bg-secondary)] flex items-center justify-center border border-[var(--color-border)]">
          <GitBranch className="w-8 h-8 text-[var(--color-text-muted)]" />
        </div>
        <h2 className="text-xl font-semibold text-[var(--color-text)] mb-2">
          Tasks require Git
        </h2>
        <p className="text-sm text-[var(--color-text-muted)] mb-6">
          Tasks run in isolated Git worktrees, which need a Git repository in this project.
          Initialize Git to unlock task creation, review and merge workflows.
        </p>
        <button
          onClick={handleInit}
          disabled={isInitializing}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[var(--color-highlight)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <GitBranch className="w-4 h-4" />
          {isInitializing ? "Initializing..." : "Initialize Git Repository"}
        </button>
        {error && (
          <p className="mt-4 text-xs text-[var(--color-error)]">{error}</p>
        )}
      </div>
    </div>
  );
}
