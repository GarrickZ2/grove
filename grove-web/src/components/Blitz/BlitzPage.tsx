import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ArrowLeft, ChevronRight, Laptop } from "lucide-react";
import { TaskInfoPanel } from "../Tasks/TaskInfoPanel";
import { TaskView, type TaskViewHandle } from "../Tasks/TaskView";
import { CommitDialog, ConfirmDialog, DirtyBranchDialog, MergeDialog } from "../Dialogs";
import { RebaseDialog } from "../Tasks/dialogs";
import { HelpOverlay } from "../Tasks/HelpOverlay";
import { ContextMenu } from "../ui/ContextMenu";
import { LogoBrand } from "../Layout/LogoBrand";
import { useNotifications, useCommandPalette } from "../../context";
import {
  useIsMobile,
  useHotkeys,
  useTaskPageState,
  useTaskNavigation,
  usePostMergeArchive,
  useTaskOperations,
  buildCommands,
} from "../../hooks";
import { useBlitzTasks } from "./useBlitzTasks";
import { BlitzTaskListItem } from "./BlitzTaskListItem";
import type { BlitzTask } from "../../data/types";
import type { PendingArchiveConfirm } from "../../utils/archiveHelpers";
import type { PanelType } from "../Tasks/PanelSystem/types";
import { buildContextMenuItems, type TaskOperationHandlers } from "../../utils/taskOperationUtils";


interface BlitzPageProps {
  onSwitchToZen: () => void;
}

export function BlitzPage({ onSwitchToZen }: BlitzPageProps) {
  const { blitzTasks, isLoading, refresh } = useBlitzTasks();
  const { getTaskNotification, dismissNotification } = useNotifications();
  const { isMobile } = useIsMobile();

  // Blitz-specific state
  const [selectedBlitzTask, setSelectedBlitzTask] = useState<BlitzTask | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  // Drag state — refs for synchronous access across DnD event handlers,
  // state copies for rendering (isDragging/isDragOver visuals)
  const dragSourceRef = useRef<"main" | "local" | null>(null);
  const draggedIndexRef = useRef<number | null>(null);
  const dragOverIndexRef = useRef<number | null>(null);
  const draggedLocalKeyRef = useRef<string | null>(null);
  const localDraggedIndexRef = useRef<number | null>(null);
  const localDragOverIndexRef = useRef<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [localDraggedIndex, setLocalDraggedIndex] = useState<number | null>(null);
  const [localDragOverIndex, setLocalDragOverIndex] = useState<number | null>(null);
  const [dragSource, setDragSource] = useState<"main" | "local" | null>(null);
  const [taskOrder, setTaskOrder] = useState<string[]>([]);
  const [localTasksExpanded, setLocalTasksExpanded] = useState(false);
  const [promotedLocalKeys, setPromotedLocalKeys] = useState<Set<string>>(new Set());
  const [localTaskOrder, setLocalTaskOrder] = useState<string[]>([]);
  const mainListRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const taskViewRef = useRef<TaskViewHandle | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

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
      pageHandlers.setInWorkspace(false);
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
      pageHandlers.setInWorkspace(false);
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
    return filteredTasks.find((bt) => bt.task.id === selectedBlitzTask.task.id && bt.projectId === selectedBlitzTask.projectId) ?? null;
  }, [filteredTasks, selectedBlitzTask]);

  // Separate filtered tasks into main-eligible and folder-local
  const mainEligibleTasks = useMemo(() => filteredTasks.filter(bt =>
    !bt.task.isLocal || promotedLocalKeys.has(`${bt.projectId}:${bt.task.id}`)
  ), [filteredTasks, promotedLocalKeys]);

  const allFolderLocalTasks = useMemo(() => filteredTasks.filter(bt =>
    bt.task.isLocal && !promotedLocalKeys.has(`${bt.projectId}:${bt.task.id}`)
  ), [filteredTasks, promotedLocalKeys]);

  // Initialize main task order (only main-eligible tasks)
  useEffect(() => {
    if (mainEligibleTasks.length > 0 && taskOrder.length === 0) {
      setTaskOrder(mainEligibleTasks.map(bt => `${bt.projectId}:${bt.task.id}`));
    }
  }, [mainEligibleTasks, taskOrder.length]);

  // Apply custom order to main list tasks
  const mainListTasks = useMemo(() => {
    if (taskOrder.length === 0) return mainEligibleTasks;

    const taskMap = new Map(mainEligibleTasks.map(bt => [`${bt.projectId}:${bt.task.id}`, bt]));
    const ordered = taskOrder
      .map(key => taskMap.get(key))
      .filter((bt): bt is BlitzTask => bt !== undefined);

    // Add any new tasks that aren't in the order yet
    const orderedKeys = new Set(taskOrder);
    const newTasks = mainEligibleTasks.filter(bt => !orderedKeys.has(`${bt.projectId}:${bt.task.id}`));

    return [...ordered, ...newTasks];
  }, [mainEligibleTasks, taskOrder]);

  // Apply custom order to folder local tasks
  const folderLocalTasks = useMemo(() => {
    if (localTaskOrder.length === 0) return allFolderLocalTasks;
    const taskMap = new Map(allFolderLocalTasks.map(bt => [`${bt.projectId}:${bt.task.id}`, bt]));
    const ordered = localTaskOrder
      .map(key => taskMap.get(key))
      .filter((bt): bt is BlitzTask => bt !== undefined);
    const orderedKeys = new Set(localTaskOrder);
    const newOnes = allFolderLocalTasks.filter(bt => !orderedKeys.has(`${bt.projectId}:${bt.task.id}`));
    return [...ordered, ...newOnes];
  }, [allFolderLocalTasks, localTaskOrder]);

  // Combined for navigation (main + visible folder locals)
  const displayTasks = useMemo(() => [...mainListTasks, ...folderLocalTasks], [mainListTasks, folderLocalTasks]);

  // Task selection handlers (Blitz-specific: handle BlitzTask)
  const handleSelectTask = useCallback((bt: BlitzTask) => {
    setSelectedBlitzTask(bt);
    if (isMobile) {
      setMobileShowDetail(true);
    }
  }, [isMobile]);

  const handleDoubleClickTask = useCallback((bt: BlitzTask) => {
    if (bt.task.status === "archived") return;
    setSelectedBlitzTask(bt);
    pageHandlers.setInWorkspace(true);
  }, [pageHandlers]);

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
          if (index < mainListTasks.length) {
            const taskToSelect = mainListTasks[index];
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
  }, [displayTasks, mainListTasks, handleSelectTask, getTaskNotification, dismissNotification]);

  // Helper: set drag ref + state together
  const setDrag = (source: "main" | "local" | null, idx: number | null, overIdx: number | null, localKey: string | null) => {
    dragSourceRef.current = source;
    draggedIndexRef.current = source === "main" ? idx : null;
    dragOverIndexRef.current = source === "main" ? overIdx : null;
    draggedLocalKeyRef.current = localKey;
    localDraggedIndexRef.current = source === "local" ? idx : null;
    localDragOverIndexRef.current = source === "local" ? overIdx : null;
    setDragSource(source);
    setDraggedIndex(source === "main" ? idx : null);
    setDragOverIndex(source === "main" ? overIdx : null);
    setLocalDraggedIndex(source === "local" ? idx : null);
    setLocalDragOverIndex(source === "local" ? overIdx : null);
  };

  // Drag and drop handlers — main list
  const handleDragStart = (index: number) => {
    dragSourceRef.current = "main";
    draggedIndexRef.current = index;
    dragOverIndexRef.current = null;
    setDraggedIndex(index);
    setDragSource("main");
  };

  const handleDragOver = (index: number) => {
    if (dragSourceRef.current !== "main") return;
    if (draggedIndexRef.current === null || draggedIndexRef.current === index) return;
    dragOverIndexRef.current = index;
    setDragOverIndex(index);
  };

  const handleDragEnd = () => {
    const src = dragSourceRef.current;
    const from = draggedIndexRef.current;
    const to = dragOverIndexRef.current;
    if (src === "main" && from !== null && to !== null && from !== to) {
      const keys = mainListTasks.map(bt => `${bt.projectId}:${bt.task.id}`);
      const [movedItem] = keys.splice(from, 1);
      keys.splice(to, 0, movedItem);
      setTaskOrder(keys);
    }
    setDrag(null, null, null, null);
  };

  const handleDragLeave = () => {
    dragOverIndexRef.current = null;
    setDragOverIndex(null);
  };

  // Drag and drop handlers — local folder
  const handleLocalDragStart = (index: number, bt: BlitzTask) => {
    dragSourceRef.current = "local";
    localDraggedIndexRef.current = index;
    localDragOverIndexRef.current = null;
    draggedLocalKeyRef.current = `${bt.projectId}:${bt.task.id}`;
    setLocalDraggedIndex(index);
    setDragSource("local");
  };

  const handleLocalDragOver = (index: number) => {
    if (dragSourceRef.current !== "local") return;
    if (localDraggedIndexRef.current === null || localDraggedIndexRef.current === index) return;
    localDragOverIndexRef.current = index;
    setLocalDragOverIndex(index);
  };

  const handleLocalDragEnd = () => {
    const src = dragSourceRef.current;
    const from = localDraggedIndexRef.current;
    const to = localDragOverIndexRef.current;
    if (src === "local" && from !== null && to !== null && from !== to) {
      const currentOrder = localTaskOrder.length > 0
        ? [...localTaskOrder]
        : folderLocalTasks.map(bt => `${bt.projectId}:${bt.task.id}`);
      if (from < currentOrder.length && to < currentOrder.length) {
        const [movedItem] = currentOrder.splice(from, 1);
        currentOrder.splice(to, 0, movedItem);
        setLocalTaskOrder(currentOrder);
      }
    }
    setDrag(null, null, null, null);
  };

  const handleLocalDragLeave = () => {
    localDragOverIndexRef.current = null;
    setLocalDragOverIndex(null);
  };

  // Demote a promoted local task back to folder
  const handleDemoteLocal = useCallback((bt: BlitzTask) => {
    const key = `${bt.projectId}:${bt.task.id}`;
    setPromotedLocalKeys(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setTaskOrder(prev => prev.filter(k => k !== key));
    setSelectedBlitzTask(prev =>
      prev?.task.id === bt.task.id && prev?.projectId === bt.projectId ? null : prev
    );
  }, []);

  // Handle drop on main list area (promote local task from folder)
  const handleMainListDragOver = useCallback((e: React.DragEvent) => {
    if (dragSourceRef.current === "local") {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }, []);

  const handleMainListDrop = useCallback((e: React.DragEvent) => {
    if (dragSourceRef.current !== "local") return;
    e.preventDefault();
    const key = draggedLocalKeyRef.current;
    if (key) {
      setPromotedLocalKeys(prev => new Set([...prev, key]));
      setTaskOrder(prev => prev.includes(key) ? prev : [...prev, key]);
      setLocalTaskOrder(prev => prev.filter(k => k !== key));
    }
    setDrag(null, null, null, null);
  }, []);

  // Handle drop on local folder (demote promoted local task from main list)
  const [localFolderDragOver, setLocalFolderDragOver] = useState(false);
  const handleLocalFolderDragOver = useCallback((e: React.DragEvent) => {
    if (dragSourceRef.current === "main" && draggedIndexRef.current !== null) {
      const bt = mainListTasks[draggedIndexRef.current];
      if (bt?.task.isLocal) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setLocalFolderDragOver(true);
      }
    }
  }, [mainListTasks]);

  const handleLocalFolderDrop = useCallback((e: React.DragEvent) => {
    if (dragSourceRef.current !== "main") return;
    e.preventDefault();
    const idx = draggedIndexRef.current;
    if (idx !== null) {
      const bt = mainListTasks[idx];
      if (bt?.task.isLocal) {
        handleDemoteLocal(bt);
      }
    }
    setDrag(null, null, null, null);
    setLocalFolderDragOver(false);
  }, [mainListTasks, handleDemoteLocal]);

  const handleLocalFolderDragLeave = useCallback(() => {
    setLocalFolderDragOver(false);
  }, []);

  // Mobile: manual move up/down (replaces drag on touch devices)
  const handleMoveTask = useCallback((index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= taskOrder.length) return;
    const newOrder = [...taskOrder];
    [newOrder[index], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[index]];
    setTaskOrder(newOrder);
  }, [taskOrder]);

  // Context menu handler (Blitz-specific: handle BlitzTask)
  const handleContextMenu = useCallback((bt: BlitzTask, e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedBlitzTask(bt);
    pageHandlers.handleContextMenu(bt.task, e);
  }, [pageHandlers]);

  // Wrap page handlers to handle selectedBlitzTask
  const handleCloseTask = useCallback(() => {
    if (pageState.inWorkspace) {
      pageHandlers.handleCloseTask();
    } else {
      setSelectedBlitzTask(null);
    }
  }, [pageState.inWorkspace, pageHandlers]);

  // Handle adding panel to TaskView
  const handleAddPanel = useCallback((type: PanelType) => {
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

  // Task navigation hook (for Blitz tasks)
  const navHandlers = useTaskNavigation({
    tasks: displayTasks.map(bt => bt.task),
    selectedTask,
    inWorkspace: pageState.inWorkspace,
    onSelectTask: (task) => {
      const bt = displayTasks.find(t => t.task.id === task.id);
      if (bt) handleSelectTask(bt);
    },
    setContextMenu: pageHandlers.setContextMenu,
  });

  // Build context menu items
  const contextMenuItems = useMemo(() => {
    if (!pageState.contextMenu) return [];
    const items = buildContextMenuItems(pageState.contextMenu.task, {
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
    } as TaskOperationHandlers);

    // Add "Move to Local folder" for promoted local tasks
    const task = pageState.contextMenu.task;
    if (task.isLocal) {
      // Find the BlitzTask to get projectId
      const bt = mainListTasks.find(b => b.task.id === task.id && b.task.isLocal);
      if (bt) {
        const key = `${bt.projectId}:${task.id}`;
        if (promotedLocalKeys.has(key)) {
          items.push(
            { id: "div-local", label: "", divider: true, onClick: () => {} },
            {
              id: "demote-local",
              label: "Move to Local",
              icon: Laptop,
              variant: "default",
              onClick: () => handleDemoteLocal(bt),
            }
          );
        }
      }
    }
    return items;
  }, [pageState.contextMenu, mainListTasks, promotedLocalKeys, opsHandlers, handleDoubleClickTask, handleDemoteLocal, currentSelected]);

  const hasTask = !!selectedTask;
  const isActive = hasTask && selectedTask.status !== "archived";
  const canOperate = isActive && selectedTask.status !== "broken";
  const notInWorkspace = !pageState.inWorkspace;

  // Workspace keyboard shortcuts (higher priority than Blitz task selection)
  // Cmd+1-9: switch panel tabs, Cmd+W / Alt+W: close active tab
  useEffect(() => {
    if (!pageState.inWorkspace) return;
    const isTauri = !!((window as Window & { __TAURI__?: unknown }).__TAURI__);
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        e.stopImmediatePropagation();
        taskViewRef.current?.selectTabByIndex(parseInt(e.key) - 1);
        return;
      }
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
  }, [pageState.inWorkspace]);

  useHotkeys(
    [
      { key: "j", handler: navHandlers.selectNextTask, options: { enabled: notInWorkspace } },
      { key: "ArrowDown", handler: navHandlers.selectNextTask, options: { enabled: notInWorkspace } },
      { key: "k", handler: navHandlers.selectPreviousTask, options: { enabled: notInWorkspace } },
      { key: "ArrowUp", handler: navHandlers.selectPreviousTask, options: { enabled: notInWorkspace } },
      {
        key: "Enter",
        handler: () => {
          if (!pageState.inWorkspace && selectedTask && selectedTask.status !== "archived") {
            pageHandlers.handleEnterWorkspace();
          }
        },
        options: { enabled: notInWorkspace && hasTask },
      },
      { key: "Escape", handler: handleCloseTask, options: { enabled: pageState.inWorkspace || hasTask } },

      // Info panel tabs (only in Task List page)
      { key: "1", handler: () => pageHandlers.setInfoPanelTab("stats"), options: { enabled: notInWorkspace && hasTask } },
      { key: "2", handler: () => pageHandlers.setInfoPanelTab("git"), options: { enabled: notInWorkspace && hasTask } },
      { key: "3", handler: () => pageHandlers.setInfoPanelTab("notes"), options: { enabled: notInWorkspace && hasTask } },
      { key: "4", handler: () => pageHandlers.setInfoPanelTab("comments"), options: { enabled: notInWorkspace && hasTask } },

      // Actions (no 'n' for new task in Blitz)
      { key: "Space", handler: navHandlers.openContextMenuAtSelectedTask, options: { enabled: hasTask && notInWorkspace } },
      { key: "c", handler: opsHandlers.handleCommit, options: { enabled: isActive } },
      { key: "s", handler: opsHandlers.handleSync, options: { enabled: canOperate } },
      { key: "m", handler: opsHandlers.handleMerge, options: { enabled: canOperate } },
      { key: "b", handler: opsHandlers.handleRebase, options: { enabled: canOperate } },
      { key: "a", handler: opsHandlers.handleArchive, options: { enabled: isActive } },
      { key: "x", handler: opsHandlers.handleReset, options: { enabled: canOperate } },
      { key: "Shift+x", handler: opsHandlers.handleClean, options: { enabled: hasTask } },
      { key: "r", handler: () => pageState.inWorkspace ? handleAddPanel("review") : handleAddPanelFromInfo("review"), options: { enabled: hasTask && isActive } },
      { key: "e", handler: () => pageState.inWorkspace ? handleAddPanel("editor") : handleAddPanelFromInfo("editor"), options: { enabled: hasTask && isActive } },
      { key: "i", handler: () => pageState.inWorkspace ? handleAddPanel("chat") : handleAddPanelFromInfo("chat"), options: { enabled: hasTask && isActive } },
      { key: "t", handler: () => pageState.inWorkspace ? handleAddPanel("terminal") : handleAddPanelFromInfo("terminal"), options: { enabled: hasTask && isActive } },

      // Search
      { key: "/", handler: () => searchInputRef.current?.focus(), options: { enabled: notInWorkspace } },

      // Help
      { key: "?", handler: () => pageHandlers.setShowHelp(!pageState.showHelp) },
    ],
    [
      navHandlers, pageHandlers, opsHandlers, handleCloseTask, handleAddPanelFromInfo, refresh,
      pageState.inWorkspace, pageState.showHelp, selectedTask, hasTask, isActive, canOperate, notInWorkspace,
    ]
  );

  // Register page-level commands for Cmd+K command palette
  const {
    registerPageCommands,
    unregisterPageCommands,
    setInWorkspace: setContextInWorkspace,
    setPageContext,
  } = useCommandPalette();

  useEffect(() => {
    setContextInWorkspace(pageState.inWorkspace);
    setPageContext(pageState.inWorkspace ? "workspace" : "tasks");
    return () => {
      setContextInWorkspace(false);
      setPageContext("default");
    };
  }, [pageState.inWorkspace, setContextInWorkspace, setPageContext]);
  const pageOptionsRef = useRef<Parameters<typeof buildCommands>[0]>(null!);
  // eslint-disable-next-line react-hooks/refs
  pageOptionsRef.current = {
    taskActions: {
      selectedTask: selectedTask ?? null,
      inWorkspace: pageState.inWorkspace,
      opsHandlers,
      onEnterWorkspace: pageHandlers.handleEnterWorkspace,
      onOpenPanel: (panel) => handleAddPanelFromInfo(panel as PanelType),
      onSwitchInfoTab: pageHandlers.setInfoPanelTab,
      onRefresh: refresh,
    },
  };

  useEffect(() => {
    registerPageCommands(() => buildCommands(pageOptionsRef.current));
    return () => unregisterPageCommands();
  }, [registerPageCommands, unregisterPageCommands]);

  const handleMobileBack = useCallback(() => {
    if (pageState.inWorkspace) {
      pageHandlers.setInWorkspace(false);
    } else {
      setMobileShowDetail(false);
    }
  }, [pageState.inWorkspace, pageHandlers]);

  return (
    <>
      {/* Blitz Sidebar — replaces the normal app sidebar */}
      <aside className={`${isMobile ? (mobileShowDetail ? "hidden" : "w-full h-full") : "w-72 h-screen"} bg-[var(--color-bg)] ${isMobile ? "" : "border-r border-[var(--color-border)]"} flex flex-col flex-shrink-0`}>
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
              {/* Main task list (regular + promoted local tasks) — drop zone for local drag-out */}
              <div
                ref={mainListRef}
                onDragOver={handleMainListDragOver}
                onDrop={handleMainListDrop}
                className={`flex flex-col gap-1.5 rounded-lg transition-colors ${
                  dragSource === "local" ? "bg-[var(--color-accent)]/5 ring-1 ring-[var(--color-accent)]/20 p-1" : ""
                }`}
              >
                {mainListTasks.map((bt, index) => {
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
                        onMoveUp={() => handleMoveTask(index, "up")}
                        onMoveDown={() => handleMoveTask(index, "down")}
                        isFirst={index === 0}
                        isLast={index === mainListTasks.length - 1}
                      />
                    </motion.div>
                  );
                })}
              </div>

              {/* Collapsible Local Tasks folder — also shown when there are promoted locals (drop target) */}
              {(folderLocalTasks.length > 0 || promotedLocalKeys.size > 0) && (
                <div
                  className={`mt-1 rounded-lg transition-colors ${
                    localFolderDragOver ? "bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]/30" : ""
                  }`}
                  onDragOver={handleLocalFolderDragOver}
                  onDrop={handleLocalFolderDrop}
                  onDragLeave={handleLocalFolderDragLeave}
                >
                  <button
                    onClick={() => setLocalTasksExpanded(!localTasksExpanded)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  >
                    <motion.span
                      animate={{ rotate: localTasksExpanded ? 90 : 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </motion.span>
                    <Laptop className="w-3.5 h-3.5 text-[var(--color-accent)]" />
                    <span>Local</span>
                    <span className="ml-auto px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[10px]">
                      {folderLocalTasks.length}
                    </span>
                  </button>
                  <AnimatePresence>
                    {localTasksExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="flex flex-col gap-1.5 pt-1.5">
                          {folderLocalTasks.map((bt, index) => {
                            const notif = getTaskNotification(bt.task.id);
                            const isThisSelected =
                              currentSelected?.task.id === bt.task.id &&
                              currentSelected?.projectId === bt.projectId;
                            return (
                              <BlitzTaskListItem
                                key={`${bt.projectId}-${bt.task.id}`}
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
                                onDragStart={() => handleLocalDragStart(index, bt)}
                                onDragOver={() => handleLocalDragOver(index)}
                                onDragEnd={handleLocalDragEnd}
                                onDragLeave={handleLocalDragLeave}
                                isDragging={localDraggedIndex === index}
                                isDragOver={localDragOverIndex === index}
                              />
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
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
      <main className={`flex-1 overflow-hidden relative ${isMobile && !mobileShowDetail ? "hidden" : ""}`}>
        {/* Mobile back button */}
        {isMobile && mobileShowDetail && (
          <div className="absolute top-2 left-2 z-10">
            <button
              onClick={handleMobileBack}
              className="flex items-center gap-1 px-2 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] bg-[var(--color-bg)]/80 backdrop-blur rounded-lg transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          </div>
        )}
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
            {/* Task List Page */}
            <motion.div
              animate={{
                opacity: pageState.inWorkspace ? 0 : 1,
                x: pageState.inWorkspace ? -20 : 0,
              }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className={`absolute inset-0 ${pageState.inWorkspace ? "pointer-events-none" : ""}`}
            >
              <AnimatePresence mode="wait">
                {!pageState.inWorkspace && currentSelected ? (
                  <motion.div
                    key="info-panel"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ type: "spring", damping: 25, stiffness: 200 }}
                    className="h-full min-w-0"
                  >
                    <TaskInfoPanel
                      projectId={currentSelected.projectId}
                      task={currentSelected.task}
                      projectName={currentSelected.projectName}
                      onClose={handleCloseTask}
                      onEnterWorkspace={currentSelected.task.status !== "archived" ? pageHandlers.handleEnterWorkspace : undefined}
                      onAddPanel={currentSelected.task.status !== "archived" ? handleAddPanelFromInfo : undefined}
                      onClean={opsHandlers.handleClean}
                      onCommit={currentSelected.task.status !== "archived" ? opsHandlers.handleCommit : undefined}
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

            {/* Workspace Page */}
            <AnimatePresence mode="popLayout">
              {pageState.inWorkspace && currentSelected && (
                <motion.div
                  key={currentSelected.task.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="absolute inset-0 flex gap-1"
                >
                  <TaskView
                    ref={taskViewRef}
                    projectId={currentSelected.projectId}
                    task={currentSelected.task}
                    projectName={currentSelected.projectName}
                    fullscreen={isFullscreen}
                    onFullscreenChange={setIsFullscreen}
                    onBack={handleCloseTask}
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
        onCancel={() => opsHandlers.handleArchiveCancel()}
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

      <DirtyBranchDialog
        error={opsState.dirtyBranchError}
        onClose={opsHandlers.handleDirtyBranchErrorClose}
      />

      <HelpOverlay isOpen={pageState.showHelp} onClose={() => pageHandlers.setShowHelp(false)} />
    </>
  );
}
