import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Terminal, GitCommit, GitBranchPlus, RefreshCw, GitMerge, Archive, RotateCcw, Trash2 } from "lucide-react";
import { TaskSidebar } from "./TaskSidebar/TaskSidebar";
import { TaskInfoPanel } from "./TaskInfoPanel";
import type { TabType } from "./TaskInfoPanel";
import { TaskView } from "./TaskView";
import { NewTaskDialog } from "./NewTaskDialog";
import { CommitDialog, ConfirmDialog, MergeDialog } from "../Dialogs";
import { RebaseDialog } from "./dialogs";
import { HelpOverlay } from "./HelpOverlay";
import { Button } from "../ui";
import { ContextMenu } from "../ui/ContextMenu";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { useProject } from "../../context";
import { useHotkeys } from "../../hooks";
import {
  createTask as apiCreateTask,
  archiveTask as apiArchiveTask,
  recoverTask as apiRecoverTask,
  deleteTask as apiDeleteTask,
  listTasks as apiListTasks,
  syncTask as apiSyncTask,
  commitTask as apiCommitTask,
  mergeTask as apiMergeTask,
  getCommits as apiGetCommits,
  resetTask as apiResetTask,
  rebaseToTask as apiRebaseToTask,
  getBranches as apiGetBranches,
  type TaskResponse,
} from "../../api";
import type { Task, TaskFilter, TaskStatus } from "../../data/types";

// Convert API TaskResponse to frontend Task type
function convertTaskResponse(task: TaskResponse): Task {
  return {
    id: task.id,
    name: task.name,
    branch: task.branch,
    target: task.target,
    status: task.status as TaskStatus,
    additions: task.additions,
    deletions: task.deletions,
    filesChanged: task.files_changed,
    commits: task.commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: "author",
      date: new Date(),
    })),
    createdAt: new Date(task.created_at),
    updatedAt: new Date(task.updated_at),
  };
}

type ViewMode = "list" | "info" | "terminal";

interface TasksPageProps {
  /** Initial task ID to select (from navigation) */
  initialTaskId?: string;
  /** Callback when navigation data has been consumed */
  onNavigationConsumed?: () => void;
}

export function TasksPage({ initialTaskId, onNavigationConsumed }: TasksPageProps) {
  const { selectedProject, refreshSelectedProject } = useProject();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [filter, setFilter] = useState<TaskFilter>("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewTaskDialog, setShowNewTaskDialog] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Auto-start session for newly created tasks
  const [autoStartSession, setAutoStartSession] = useState(false);

  // Loading states
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Commit dialog state
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Merge dialog state
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Post-merge archive confirm dialog state (TUI: ConfirmType::MergeSuccess)
  const [showArchiveAfterMerge, setShowArchiveAfterMerge] = useState(false);
  const [mergedTaskId, setMergedTaskId] = useState<string | null>(null);
  const [mergedTaskName, setMergedTaskName] = useState<string>("");

  // Clean confirm dialog state
  const [showCleanConfirm, setShowCleanConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);

  // Reset confirm dialog state
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Rebase dialog state
  const [showRebaseDialog, setShowRebaseDialog] = useState(false);
  const [isRebasing, setIsRebasing] = useState(false);
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);

  // Operation message toast
  const [operationMessage, setOperationMessage] = useState<string | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ task: Task; position: { x: number; y: number } } | null>(null);

  // Archived tasks (loaded separately)
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);

  // Help overlay state
  const [showHelp, setShowHelp] = useState(false);

  // Info panel tab state (lifted for hotkey control)
  const [infoPanelTab, setInfoPanelTab] = useState<TabType>("stats");

  // Search input ref for / hotkey
  const searchInputRef = useRef<HTMLInputElement | null>(null);

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
    if (initialTaskId && activeTasks.length > 0 && !selectedTask) {
      const task = activeTasks.find((t) => t.id === initialTaskId);
      if (task) {
        setSelectedTask(task);
        setViewMode("info");
        // Consume the navigation data so it doesn't re-trigger
        onNavigationConsumed?.();
      }
    }
  }, [initialTaskId, activeTasks, selectedTask, onNavigationConsumed]);

  // Filter and search tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // For active filter, exclude archived status (in case API returns them)
      if (filter === "active" && task.status === "archived") {
        return false;
      }

      // Apply search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          task.name.toLowerCase().includes(query) ||
          task.branch.toLowerCase().includes(query)
        );
      }

      return true;
    });
  }, [tasks, filter, searchQuery]);

  // Handle single click - show Info Panel
  const handleSelectTask = (task: Task) => {
    setSelectedTask(task);
    setAutoStartSession(false); // Reset auto-start when manually selecting
    if (viewMode === "list") {
      setViewMode("info");
    }
  };

  // Handle double click - enter Terminal mode (only for non-archived tasks)
  const handleDoubleClickTask = (task: Task) => {
    if (task.status === "archived") return;
    setSelectedTask(task);
    setAutoStartSession(false); // Reset auto-start when manually selecting
    setViewMode("terminal");
    setReviewOpen(false);
    setEditorOpen(false);
  };

  // Handle closing task view - return to list mode
  const handleCloseTask = () => {
    if (viewMode === "terminal") {
      // From terminal, go back to info mode
      setViewMode("info");
      setReviewOpen(false);
      setEditorOpen(false);
    } else {
      // From info, go back to list mode
      setSelectedTask(null);
      setViewMode("list");
    }
  };

  // Handle entering terminal mode from info panel (only for non-archived tasks)
  const handleEnterTerminal = () => {
    if (selectedTask?.status === "archived") return;
    setViewMode("terminal");
  };

  // Handle recover archived task
  const handleRecover = useCallback(async () => {
    if (!selectedProject || !selectedTask) return;
    try {
      await apiRecoverTask(selectedProject.id, selectedTask.id);
      await refreshSelectedProject();
      // Clear archived tasks cache so it reloads
      setArchivedTasks((prev) => prev.filter((t) => t.id !== selectedTask.id));
      // Update local state to reflect the change
      setSelectedTask(null);
      setViewMode("list");
      // Switch to active filter to see the recovered task
      setFilter("active");
    } catch (err) {
      console.error("Failed to recover task:", err);
      const errorMessage = err instanceof Error ? err.message :
        (err as { message?: string })?.message || "Failed to recover task";
      setOperationMessage(errorMessage);
      setTimeout(() => setOperationMessage(null), 3000);
    }
  }, [selectedProject, selectedTask, refreshSelectedProject]);

  // Handle toggle review (mutual exclusion with editor)
  const handleToggleReview = () => {
    if (!reviewOpen) setEditorOpen(false);
    setReviewOpen(!reviewOpen);
  };

  // Handle toggle editor (mutual exclusion with review)
  const handleToggleEditor = () => {
    if (!editorOpen) setReviewOpen(false);
    setEditorOpen(!editorOpen);
  };

  // Handle new task creation
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
        setSelectedTask(newTask);
        setAutoStartSession(true);
        setViewMode("terminal");
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
    [selectedProject, refreshSelectedProject]
  );

  // Show toast message
  const showMessage = (message: string) => {
    setOperationMessage(message);
    setTimeout(() => setOperationMessage(null), 3000);
  };

  // Handle task actions
  const handleCommit = () => {
    setCommitError(null);
    setShowCommitDialog(true);
  };

  const handleCommitSubmit = useCallback(async (message: string) => {
    if (!selectedProject || !selectedTask) return;
    try {
      setIsCommitting(true);
      setCommitError(null);
      const result = await apiCommitTask(selectedProject.id, selectedTask.id, message);
      if (result.success) {
        showMessage("Changes committed successfully");
        setShowCommitDialog(false);
        await refreshSelectedProject();
      } else {
        setCommitError(result.message || "Commit failed");
      }
    } catch (err) {
      console.error("Failed to commit:", err);
      setCommitError("Failed to commit changes");
    } finally {
      setIsCommitting(false);
    }
  }, [selectedProject, selectedTask, refreshSelectedProject]);

  // Handle rebase - TUI: opens branch selector to change target branch
  const handleRebase = useCallback(async () => {
    if (!selectedProject) return;
    try {
      // Fetch available branches
      const branchesRes = await apiGetBranches(selectedProject.id);
      setAvailableBranches(branchesRes.branches.map((b) => b.name));
      setShowRebaseDialog(true);
    } catch (err) {
      console.error("Failed to fetch branches:", err);
      showMessage("Failed to load branches");
    }
  }, [selectedProject]);

  // Handle rebase submit
  const handleRebaseSubmit = useCallback(async (newTarget: string) => {
    if (!selectedProject || !selectedTask || isRebasing) return;
    try {
      setIsRebasing(true);
      const result = await apiRebaseToTask(selectedProject.id, selectedTask.id, newTarget);
      if (result.success) {
        showMessage(result.message || "Target branch changed");
        setShowRebaseDialog(false);
        await refreshSelectedProject();
        // Update selected task with new target
        setSelectedTask((prev) => prev ? { ...prev, target: newTarget } : null);
      } else {
        showMessage(result.message || "Failed to change target branch");
      }
    } catch (err) {
      console.error("Failed to rebase:", err);
      const errorMessage = err instanceof Error ? err.message :
        (err as { message?: string })?.message || "Failed to change target branch";
      showMessage(errorMessage);
    } finally {
      setIsRebasing(false);
    }
  }, [selectedProject, selectedTask, isRebasing, refreshSelectedProject]);

  // Handle review from info mode - enter terminal mode with review panel open
  const handleReviewFromInfo = () => {
    setViewMode("terminal");
    setReviewOpen(true);
    setEditorOpen(false);
  };

  // Handle editor from info mode - enter terminal mode with editor panel open
  const handleEditorFromInfo = () => {
    setViewMode("terminal");
    setEditorOpen(true);
    setReviewOpen(false);
  };

  const handleSync = useCallback(async () => {
    if (!selectedProject || !selectedTask || isSyncing) return;
    try {
      setIsSyncing(true);
      const result = await apiSyncTask(selectedProject.id, selectedTask.id);
      showMessage(result.message || (result.success ? "Synced successfully" : "Sync failed"));
      if (result.success) {
        await refreshSelectedProject();
      }
    } catch (err) {
      console.error("Failed to sync:", err);
      showMessage("Failed to sync task");
    } finally {
      setIsSyncing(false);
    }
  }, [selectedProject, selectedTask, isSyncing, refreshSelectedProject]);

  // Handle merge - TUI logic: check commit count first
  // If commits <= 1, merge directly; if > 1, show dialog to choose method
  const handleMerge = useCallback(async () => {
    if (!selectedProject || !selectedTask || isMerging) return;

    try {
      // Get commit count (TUI: open_merge_dialog)
      const commitsRes = await apiGetCommits(selectedProject.id, selectedTask.id);
      const commitCount = commitsRes.total;

      if (commitCount <= 1) {
        // Only 1 commit, merge directly with merge-commit method (TUI logic)
        setIsMerging(true);
        const result = await apiMergeTask(selectedProject.id, selectedTask.id, "merge-commit");
        setIsMerging(false);

        if (result.success) {
          showMessage(result.message || "Merged successfully");
          await refreshSelectedProject();
          // Show archive confirm dialog (TUI: ConfirmType::MergeSuccess)
          setMergedTaskId(selectedTask.id);
          setMergedTaskName(selectedTask.name);
          setShowArchiveAfterMerge(true);
        } else {
          showMessage(result.message || "Merge failed");
        }
      } else {
        // Multiple commits, show dialog to choose method
        setMergeError(null);
        setShowMergeDialog(true);
      }
    } catch (err) {
      console.error("Failed to get commits:", err);
      // Fallback: show merge dialog
      setMergeError(null);
      setShowMergeDialog(true);
    }
  }, [selectedProject, selectedTask, isMerging, refreshSelectedProject]);

  const handleMergeSubmit = useCallback(async (method: "squash" | "merge-commit") => {
    if (!selectedProject || !selectedTask || isMerging) return;
    try {
      setIsMerging(true);
      setMergeError(null);
      const result = await apiMergeTask(selectedProject.id, selectedTask.id, method);
      if (result.success) {
        showMessage(result.message || "Merged successfully");
        setShowMergeDialog(false);
        await refreshSelectedProject();
        // Show archive confirm dialog (TUI: ConfirmType::MergeSuccess)
        setMergedTaskId(selectedTask.id);
        setMergedTaskName(selectedTask.name);
        setShowArchiveAfterMerge(true);
      } else {
        setMergeError(result.message || "Merge failed");
      }
    } catch (err) {
      console.error("Failed to merge:", err);
      setMergeError("Failed to merge task");
    } finally {
      setIsMerging(false);
    }
  }, [selectedProject, selectedTask, isMerging, refreshSelectedProject]);

  // Handle archive after merge (TUI: PendingAction::MergeArchive)
  const handleArchiveAfterMerge = useCallback(async () => {
    if (!selectedProject || !mergedTaskId) return;
    try {
      await apiArchiveTask(selectedProject.id, mergedTaskId);
      await refreshSelectedProject();
      showMessage("Task archived");
    } catch (err) {
      console.error("Failed to archive task:", err);
      showMessage("Failed to archive task");
    } finally {
      setShowArchiveAfterMerge(false);
      setMergedTaskId(null);
      setMergedTaskName("");
      setSelectedTask(null);
      setViewMode("list");
    }
  }, [selectedProject, mergedTaskId, refreshSelectedProject]);

  const handleSkipArchive = useCallback(() => {
    setShowArchiveAfterMerge(false);
    setMergedTaskId(null);
    setMergedTaskName("");
    setSelectedTask(null);
    setViewMode("list");
  }, []);
  const handleArchive = useCallback(async () => {
    if (!selectedProject || !selectedTask) return;
    try {
      await apiArchiveTask(selectedProject.id, selectedTask.id);
      await refreshSelectedProject();
      setSelectedTask(null);
      setViewMode("list");
    } catch (err) {
      console.error("Failed to archive task:", err);
    }
  }, [selectedProject, selectedTask, refreshSelectedProject]);
  const handleClean = () => {
    setShowCleanConfirm(true);
  };

  const handleCleanConfirm = useCallback(async () => {
    if (!selectedProject || !selectedTask || isDeleting) return;
    try {
      setIsDeleting(true);
      await apiDeleteTask(selectedProject.id, selectedTask.id);
      await refreshSelectedProject();
      showMessage("Task deleted successfully");
      setSelectedTask(null);
      setViewMode("list");
    } catch (err) {
      console.error("Failed to delete task:", err);
      showMessage("Failed to delete task");
    } finally {
      setIsDeleting(false);
      setShowCleanConfirm(false);
    }
  }, [selectedProject, selectedTask, isDeleting, refreshSelectedProject]);
  // Handle reset - TUI logic: show confirmation, then reset
  const handleReset = () => {
    setShowResetConfirm(true);
  };

  const handleResetConfirm = useCallback(async () => {
    if (!selectedProject || !selectedTask || isResetting) return;
    try {
      setIsResetting(true);
      const result = await apiResetTask(selectedProject.id, selectedTask.id);
      if (result.success) {
        showMessage(result.message || "Task reset successfully");
        await refreshSelectedProject();
        // Note: TUI auto-enters terminal after reset, but in web we stay in info mode
      } else {
        showMessage(result.message || "Reset failed");
      }
    } catch (err) {
      console.error("Failed to reset task:", err);
      const errorMessage = err instanceof Error ? err.message :
        (err as { message?: string })?.message || "Failed to reset task";
      showMessage(errorMessage);
    } finally {
      setIsResetting(false);
      setShowResetConfirm(false);
    }
  }, [selectedProject, selectedTask, isResetting, refreshSelectedProject]);
  // Context menu handlers
  const handleContextMenu = useCallback((task: Task, e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedTask(task);
    setContextMenu({ task, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const getContextMenuItems = (task: Task): ContextMenuItem[] => {
    if (task.status === "archived") {
      return [
        { id: "recover", label: "Recover", icon: RotateCcw, variant: "default", onClick: handleRecover },
        { id: "div-1", label: "", divider: true, onClick: () => {} },
        { id: "clean", label: "Clean", icon: Trash2, variant: "danger", onClick: handleClean },
      ];
    }

    const canOperate = task.status !== "broken";
    return [
      { id: "terminal", label: "Enter Terminal", icon: Terminal, variant: "default", onClick: () => handleDoubleClickTask(task) },
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

  const handleStartSession = () => {
    // Start session and enter terminal mode
    setViewMode("terminal");
  };

  // Handle terminal connected - refresh to update task status to "live"
  const handleTerminalConnected = useCallback(async () => {
    await refreshSelectedProject();
    setAutoStartSession(false);
  }, [refreshSelectedProject]);

  // --- Hotkey helpers ---
  const selectNextTask = useCallback(() => {
    if (filteredTasks.length === 0) return;
    const currentIndex = selectedTask
      ? filteredTasks.findIndex((t) => t.id === selectedTask.id)
      : -1;
    const nextIndex = currentIndex < filteredTasks.length - 1 ? currentIndex + 1 : 0;
    const nextTask = filteredTasks[nextIndex];
    setSelectedTask(nextTask);
    if (viewMode === "list") setViewMode("info");
    // Scroll the task into view
    const el = document.querySelector(`[data-task-id="${nextTask.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [filteredTasks, selectedTask, viewMode]);

  const selectPreviousTask = useCallback(() => {
    if (filteredTasks.length === 0) return;
    const currentIndex = selectedTask
      ? filteredTasks.findIndex((t) => t.id === selectedTask.id)
      : -1;
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : filteredTasks.length - 1;
    const prevTask = filteredTasks[prevIndex];
    setSelectedTask(prevTask);
    if (viewMode === "list") setViewMode("info");
    const el = document.querySelector(`[data-task-id="${prevTask.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [filteredTasks, selectedTask, viewMode]);

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
  const isArchived = hasTask && selectedTask.status === "archived";
  const canOperate = isActive && selectedTask.status !== "broken";
  const notTerminal = viewMode !== "terminal";

  // --- Register all hotkeys ---
  useHotkeys(
    [
      // Navigation
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
      {
        key: "Escape",
        handler: handleCloseTask,
        options: { enabled: viewMode !== "list" },
      },

      // Info panel tabs
      { key: "1", handler: () => setInfoPanelTab("stats"), options: { enabled: notTerminal && hasTask } },
      { key: "2", handler: () => setInfoPanelTab("git"), options: { enabled: notTerminal && hasTask } },
      { key: "3", handler: () => setInfoPanelTab("notes"), options: { enabled: notTerminal && hasTask } },
      { key: "4", handler: () => setInfoPanelTab("comments"), options: { enabled: notTerminal && hasTask } },

      // Actions (work in all modes; xterm focus auto-suppresses via useHotkeys)
      { key: "n", handler: () => setShowNewTaskDialog(true) },
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
          if (isArchived) {
            handleRecover();
          } else if (isActive) {
            handleReset();
          }
        },
        options: { enabled: hasTask },
      },

      // Search
      {
        key: "/",
        handler: () => searchInputRef.current?.focus(),
        options: { enabled: notTerminal },
      },

      // Help
      { key: "?", handler: () => setShowHelp((v) => !v) },
    ],
    [
      selectNextTask, selectPreviousTask, handleCloseTask,
      handleEnterTerminal, openContextMenuAtSelectedTask,
      handleCommit, handleSync, handleMerge, handleRebase,
      handleArchive, handleClean, handleRecover, handleReset,
      viewMode, selectedTask, hasTask, isActive, isArchived, canOperate, notTerminal,
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

  const isTerminalMode = viewMode === "terminal";
  const isInfoMode = viewMode === "info";

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
            onClick={() => setShowHelp(true)}
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
              selectedTask={selectedTask}
              filter={filter}
              searchQuery={searchQuery}
              isLoading={filter === "archived" && isLoadingArchived}
              searchInputRef={searchInputRef}
              onSelectTask={handleSelectTask}
              onDoubleClickTask={handleDoubleClickTask}
              onContextMenuTask={handleContextMenu}
              onFilterChange={setFilter}
              onSearchChange={setSearchQuery}
            />
          </div>

          {/* Right Panel: Empty State or Info Panel */}
          <div className="flex-1 h-full">
            <AnimatePresence mode="wait">
              {isInfoMode && selectedTask ? (
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
                    task={selectedTask}
                    onClose={handleCloseTask}
                    onEnterTerminal={selectedTask.status !== "archived" ? handleEnterTerminal : undefined}
                    onRecover={selectedTask.status === "archived" ? handleRecover : undefined}
                    onClean={handleClean}
                    onCommit={selectedTask.status !== "archived" ? handleCommit : undefined}
                    onReview={selectedTask.status !== "archived" ? handleReviewFromInfo : undefined}
                    onEditor={selectedTask.status !== "archived" ? handleEditorFromInfo : undefined}
                    onRebase={selectedTask.status !== "archived" ? handleRebase : undefined}
                    onSync={selectedTask.status !== "archived" ? handleSync : undefined}
                    onMerge={selectedTask.status !== "archived" ? handleMerge : undefined}
                    onArchive={selectedTask.status !== "archived" ? handleArchive : undefined}
                    onReset={selectedTask.status !== "archived" ? handleReset : undefined}
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
          </div>
        </motion.div>

        {/* Terminal Mode: Info Panel + TaskView */}
        <AnimatePresence>
          {isTerminalMode && selectedTask && (
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
                task={selectedTask}
                onClose={handleCloseTask}
                isTerminalMode
              />

              {/* TaskView (Terminal + optional Code Review / Editor) */}
              <TaskView
                projectId={selectedProject.id}
                task={selectedTask}
                reviewOpen={reviewOpen}
                editorOpen={editorOpen}
                autoStartSession={autoStartSession}
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

      {/* Operation Message Toast */}
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
        isOpen={showCommitDialog}
        isLoading={isCommitting}
        error={commitError}
        onCommit={handleCommitSubmit}
        onCancel={() => {
          setShowCommitDialog(false);
          setCommitError(null);
        }}
      />

      {/* Merge Dialog */}
      <MergeDialog
        isOpen={showMergeDialog}
        taskName={selectedTask?.name || ""}
        branchName={selectedTask?.branch || ""}
        targetBranch={selectedTask?.target || ""}
        isLoading={isMerging}
        error={mergeError}
        onMerge={handleMergeSubmit}
        onCancel={() => {
          setShowMergeDialog(false);
          setMergeError(null);
        }}
      />

      {/* Clean Confirm Dialog */}
      <ConfirmDialog
        isOpen={showCleanConfirm}
        title="Delete Task"
        message={`Are you sure you want to delete "${selectedTask?.name}"? This will remove the worktree and all associated data. This action cannot be undone.`}
        confirmLabel={isDeleting ? "Deleting..." : "Delete"}
        variant="danger"
        onConfirm={handleCleanConfirm}
        onCancel={() => setShowCleanConfirm(false)}
      />

      {/* Archive after Merge Confirm Dialog (TUI: ConfirmType::MergeSuccess) */}
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

      {/* Reset Confirm Dialog (TUI: ConfirmType::Reset) */}
      <ConfirmDialog
        isOpen={showResetConfirm}
        title="Reset Task"
        message={`Are you sure you want to reset "${selectedTask?.name}"? This will discard all changes and recreate the worktree from ${selectedTask?.target}. This action cannot be undone.`}
        confirmLabel={isResetting ? "Resetting..." : "Reset"}
        variant="danger"
        onConfirm={handleResetConfirm}
        onCancel={() => setShowResetConfirm(false)}
      />

      {/* Rebase Dialog (Change Target Branch) */}
      <RebaseDialog
        isOpen={showRebaseDialog}
        taskName={selectedTask?.name}
        currentTarget={selectedTask?.target || ""}
        availableBranches={availableBranches}
        onClose={() => setShowRebaseDialog(false)}
        onRebase={handleRebaseSubmit}
      />

      {/* Task Context Menu */}
      <ContextMenu
        items={contextMenu ? getContextMenuItems(contextMenu.task) : []}
        position={contextMenu?.position ?? null}
        onClose={closeContextMenu}
      />

      {/* Help Overlay */}
      <HelpOverlay isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </motion.div>
  );
}
