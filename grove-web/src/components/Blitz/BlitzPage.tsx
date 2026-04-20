import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ArrowLeft, ChevronRight, Laptop, Radio, Plus, Folder } from "lucide-react";
import { TaskInfoPanel } from "../Tasks/TaskInfoPanel";
import { TaskView, type TaskViewHandle } from "../Tasks/TaskView";
import { CommitDialog, ConfirmDialog, DirtyBranchDialog, MergeDialog } from "../Dialogs";
import { RebaseDialog } from "../Tasks/dialogs";
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
  useTaskGroups,
  useRadioEvents,
  buildCommands,
} from "../../hooks";
import { RadioConnectDialog } from "./RadioConnectDialog";
import { useBlitzTasks } from "./useBlitzTasks";
import { BlitzTaskListItem } from "./BlitzTaskListItem";
import type { BlitzTask } from "../../data/types";
import { MAIN_GROUP_ID, LOCAL_GROUP_ID } from "../../data/types";
import type { PendingArchiveConfirm } from "../../utils/archiveHelpers";
import type { PanelType } from "../Tasks/PanelSystem/types";
import { buildContextMenuItems, type TaskOperationHandlers } from "../../utils/taskOperationUtils";


interface DragInfo {
  source: "main" | "group" | "local";
  taskKey: string;           // `${projectId}:${taskId}`
  index: number;             // index in source list
  groupId: string;           // always present — MAIN_GROUP_ID, LOCAL_GROUP_ID, or custom UUID
}

interface BlitzPageProps {
  onSwitchToZen: () => void;
  onNavigate?: (page: string) => void;
}

export function BlitzPage({ onSwitchToZen, onNavigate }: BlitzPageProps) {
  const { blitzTasks, isLoading, refresh } = useBlitzTasks();
  const { getTaskNotification, dismissNotification } = useNotifications();
  const { isMobile } = useIsMobile();

  // TaskGroup state (folder-based)
  const taskGroupsHook = useTaskGroups();
  const {
    groups: taskGroups,
    createGroup: createTaskGroup,
    updateGroup: updateTaskGroup,
    deleteGroup: deleteTaskGroup,
  } = taskGroupsHook;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const newGroupInputRef = useRef<HTMLInputElement | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const editGroupInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<{ id: string; name: string } | null>(null);
  const [groupFolderContextMenu, setGroupFolderContextMenu] = useState<{ id: string; name: string; position: { x: number; y: number } } | null>(null);

  // Radio connect dialog
  const [showRadioConnect, setShowRadioConnect] = useState(false);

  // Blitz-specific state
  const [selectedBlitzTask, setSelectedBlitzTask] = useState<BlitzTask | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  // ── Unified drag-and-drop state ──────────────────────────────────────────
  // Single ref tracks the drag source; render state tracks visual feedback
  const dragInfoRef = useRef<DragInfo | null>(null);
  const dropTargetRef = useRef<{ zone: "main" | "group" | "local"; index?: number; groupId?: string } | null>(null);
  const [dragState, setDragState] = useState<{
    source: "main" | "group" | "local" | null;
    taskKey: string | null;
    overZone: "main" | "group" | "local" | null;
    overIndex: number | null;
    overGroupId: string | null;
  }>({ source: null, taskKey: null, overZone: null, overIndex: null, overGroupId: null });

  const clearDrag = useCallback(() => {
    dragInfoRef.current = null;
    dropTargetRef.current = null;
    setDragState({ source: null, taskKey: null, overZone: null, overIndex: null, overGroupId: null });
  }, []);

  const [localTasksExpanded, setLocalTasksExpanded] = useState(false);
  const mainListRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Callback ref: only SET on mount, never clear on unmount.
  // This prevents AnimatePresence exit animation from clearing the ref
  // when the old TaskView unmounts after the new one has already mounted.
  const taskViewRef = useRef<TaskViewHandle | null>(null);
  const taskViewCallbackRef = useCallback((handle: TaskViewHandle | null) => {
    if (handle) taskViewRef.current = handle;
  }, []);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Archive confirmation state (shared between hooks)
  const [pendingArchiveConfirm, setPendingArchiveConfirm] = useState<PendingArchiveConfirm | null>(null);

  // Derived helpers (use effectiveSelectedBlitzTask once computed below; for hooks that don't depend on it, raw is fine)
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

  // Radio events: desktop receives focus/prompt events from Radio phone
  const blitzTasksRef = useRef(blitzTasks);
  useEffect(() => { blitzTasksRef.current = blitzTasks; }, [blitzTasks]);
  const radioFocusedTaskRef = useRef<string | null>(null);

  // Helper: ensure the right panel is open for the currently selected task.
  // Does NOT call setSelectedBlitzTask — task selection is handled by onFocusTask.
  const ensureRadioPanel = useCallback((panelType: "chat" | "terminal") => {
    const tryEnsure = (attempts: number) => {
      if (taskViewRef.current) {
        taskViewRef.current.ensurePanel(panelType);
      } else if (attempts > 0) {
        setTimeout(() => tryEnsure(attempts - 1), 100);
      }
    };
    setTimeout(() => tryEnsure(10), 100);
  }, []);

  const { radioClients } = useRadioEvents({
    onFocusTask: useCallback((projectId: string, taskId: string, target?: import("../../api/walkieTalkie").TargetMode) => {
      const taskKey = `${projectId}:${taskId}`;
      const bt = blitzTasksRef.current.find(
        (t) => t.projectId === projectId && t.task.id === taskId,
      );
      if (!bt || bt.task.status === "archived") return;

      setSelectedBlitzTask(bt);
      pageHandlers.setInWorkspace(true);

      // Switch panel based on Radio's target mode
      const panelType = target?.mode === "terminal" ? "terminal" : "chat";
      if (radioFocusedTaskRef.current !== taskKey) {
        radioFocusedTaskRef.current = taskKey;
        ensureRadioPanel(panelType);
      }

      // Clear any stale pending chat from a previous focus event
      delete (window as unknown as Record<string, unknown>).__grove_pending_chat;

      // Tell TaskChat which session to show (Radio's active session)
      if (target?.mode === "chat" && "chat_id" in target && target.chat_id) {
        const chatId = target.chat_id;
        // Store as pending so TaskChat can pick it up on mount (before its listener is set up)
        (window as unknown as Record<string, unknown>).__grove_pending_chat = { projectId, taskId, chatId };
        window.dispatchEvent(new CustomEvent("grove:switch-chat", {
          detail: { projectId, taskId, chatId },
        }));
      }
    }, [pageHandlers, ensureRadioPanel]),

    onFocusTarget: useCallback((_projectId: string, _taskId: string, target: import("../../api/walkieTalkie").TargetMode) => {
      // Only switch panel — task selection is already handled by onFocusTask (tap/hold)
      const panelType = target.mode === "terminal" ? "terminal" : "chat";
      ensureRadioPanel(panelType);
      // If chat mode with specific session, tell TaskChat to switch
      if (target.mode === "chat" && "chat_id" in target && target.chat_id) {
        window.dispatchEvent(new CustomEvent("grove:switch-chat", {
          detail: { projectId: _projectId, taskId: _taskId, chatId: target.chat_id },
        }));
      }
    }, [ensureRadioPanel]),

    onTerminalInput: useCallback((_projectId: string, _taskId: string, text: string) => {
      // Send input to terminal — task should already be selected via prior events
      const targetKey = `${_projectId}:${_taskId}`;
      const trySend = (attempts: number) => {
        // Bail if task changed since event was received
        if (radioFocusedTaskRef.current && radioFocusedTaskRef.current !== targetKey) return;
        if (taskViewRef.current) {
          taskViewRef.current.ensurePanel("terminal");
          const sent = taskViewRef.current.sendTerminalInput(text.trimEnd() + "\r");
          if (!sent && attempts > 0) {
            setTimeout(() => trySend(attempts - 1), 200);
          }
        } else if (attempts > 0) {
          setTimeout(() => trySend(attempts - 1), 200);
        }
      };
      setTimeout(() => trySend(15), 100);
    }, []),
  });
  const radioConnected = radioClients > 0;

  // Auto-close Radio connect dialog when a phone connects
  // Derived: if radio is connected, never show the connect dialog
  const effectiveShowRadioConnect = showRadioConnect && !radioConnected;

  // Filter tasks by search query (match task name, branch, or project name)
  const searchFilteredTasks = useMemo(() => {
    if (!pageState.searchQuery) return blitzTasks;
    const q = pageState.searchQuery.toLowerCase();
    return blitzTasks.filter(
      (bt) =>
        bt.task.name.toLowerCase().includes(q) ||
        bt.task.branch.toLowerCase().includes(q) ||
        bt.projectName.toLowerCase().includes(q)
    );
  }, [blitzTasks, pageState.searchQuery]);

  const filteredTasks = searchFilteredTasks;

  // Pre-built map from task key to BlitzTask (shared across getGroupTasks calls)
  const taskMap = useMemo(
    () => new Map(filteredTasks.map(bt => [`${bt.projectId}:${bt.task.id}`, bt])),
    [filteredTasks],
  );

  // Get tasks for a specific group
  const getGroupTasks = useCallback((group: { slots: { position: number; project_id: string; task_id: string }[] } | undefined) => {
    if (!group) return [];
    // Return tasks sorted by slot position
    return group.slots
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(s => taskMap.get(`${s.project_id}:${s.task_id}`))
      .filter((bt): bt is BlitzTask => bt !== undefined);
  }, [taskMap]);

  // Keep selectedBlitzTask in sync with refreshed data
  const currentSelected = useMemo(() => {
    if (!selectedBlitzTask) return null;
    return filteredTasks.find((bt) => bt.task.id === selectedBlitzTask.task.id && bt.projectId === selectedBlitzTask.projectId) ?? null;
  }, [filteredTasks, selectedBlitzTask]);

  // Derive studio status from current selection — kept in sync via React state
  const isStudioTask = currentSelected?.projectType === "studio";

  // Clear stale taskViewRef when no task is selected
  useEffect(() => {
    if (!currentSelected) taskViewRef.current = null;
  }, [currentSelected]);

  // Derive task lists from groups
  const mainGroup = useMemo(() => taskGroups.find(g => g.id === MAIN_GROUP_ID), [taskGroups]);
  const localGroup = useMemo(() => taskGroups.find(g => g.id === LOCAL_GROUP_ID), [taskGroups]);
  const customGroups = useMemo(() => taskGroups.filter(g => g.id !== MAIN_GROUP_ID && g.id !== LOCAL_GROUP_ID), [taskGroups]);

  const mainListTasks = useMemo(() => getGroupTasks(mainGroup), [getGroupTasks, mainGroup]);
  const folderLocalTasks = useMemo(() => getGroupTasks(localGroup), [getGroupTasks, localGroup]);

  // Combined for navigation: main + group folder tasks (if expanded) + local folder tasks
  const expandedGroupTasks = useMemo(() => {
    const tasks: BlitzTask[] = [];
    for (const group of customGroups) {
      if (expandedGroups.has(group.id)) {
        tasks.push(...getGroupTasks(group));
      }
    }
    return tasks;
  }, [customGroups, expandedGroups, getGroupTasks]);

  const displayTasks = useMemo(() => [...mainListTasks, ...expandedGroupTasks, ...folderLocalTasks], [mainListTasks, expandedGroupTasks, folderLocalTasks]);

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
  }, [mainListTasks, handleSelectTask, getTaskNotification, dismissNotification]);

  // ── Unified drag handlers ───────────────────────────────────────────────

  const startDrag = useCallback((source: "main" | "group" | "local", index: number, taskKey: string, groupId: string) => {
    dragInfoRef.current = { source, taskKey, index, groupId };
    setDragState({ source, taskKey, overZone: null, overIndex: null, overGroupId: null });
  }, []);

  const handleItemDragOver = useCallback((e: React.DragEvent, zone: "main" | "group" | "local", index: number, groupId?: string) => {
    if (!dragInfoRef.current) return;
    e.stopPropagation(); // Prevent zone-level handler from overriding index to -1
    dropTargetRef.current = { zone, index, groupId };
    setDragState(prev => ({ ...prev, overZone: zone, overIndex: index, overGroupId: groupId ?? null }));
  }, []);

  const handleZoneDragOver = useCallback((e: React.DragEvent, zone: "main" | "group" | "local", groupId?: string) => {
    if (!dragInfoRef.current) return;
    // Don't accept drop from same group to same group header (only to items within)
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dropTargetRef.current = { zone, index: -1, groupId };
    setDragState(prev => ({ ...prev, overZone: zone, overIndex: null, overGroupId: groupId ?? null }));
  }, []);

  const handleDragLeave = useCallback(() => {
    dropTargetRef.current = null;
    setDragState(prev => ({ ...prev, overZone: null, overIndex: null, overGroupId: null }));
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const info = dragInfoRef.current;
    const target = dropTargetRef.current;
    if (!info || !target) { clearDrag(); return; }

    const { taskKey, groupId: srcGroupId } = info;
    const { groupId: tgtGroupId } = target;
    const targetIndex = target.index ?? -1;

    // Find the BlitzTask
    const bt = blitzTasks.find(b => `${b.projectId}:${b.task.id}` === taskKey);
    if (!bt) { clearDrag(); return; }

    const resolvedTgtGroupId = tgtGroupId ?? srcGroupId;

    // ── Same group reorder ──
    if (srcGroupId === resolvedTgtGroupId && targetIndex >= 0 && info.index !== targetIndex) {
      const group = taskGroups.find(g => g.id === srcGroupId);
      if (group) {
        const tasksInGroup = getGroupTasks(group);
        if (info.index < tasksInGroup.length && targetIndex < tasksInGroup.length) {
          const srcTask = tasksInGroup[info.index];
          const tgtTask = tasksInGroup[targetIndex];
          // Find their slots in the full list and swap positions
          const newSlots = group.slots.map(s => {
            if (s.project_id === srcTask.projectId && s.task_id === srcTask.task.id) {
              const tgtSlot = group.slots.find(ts => ts.project_id === tgtTask.projectId && ts.task_id === tgtTask.task.id);
              return { ...s, position: tgtSlot?.position ?? s.position };
            }
            if (s.project_id === tgtTask.projectId && s.task_id === tgtTask.task.id) {
              const srcSlot = group.slots.find(ss => ss.project_id === srcTask.projectId && ss.task_id === srcTask.task.id);
              return { ...s, position: srcSlot?.position ?? s.position };
            }
            return s;
          }).sort((a, b) => a.position - b.position);
          taskGroupsHook.setSlots(srcGroupId, newSlots);
        }
      }
      clearDrag();
      return;
    }

    // ── Cross-group move ──
    if (srcGroupId !== resolvedTgtGroupId) {
      taskGroupsHook.moveTask(srcGroupId, resolvedTgtGroupId, bt.projectId, bt.task.id);
    }

    clearDrag();
  }, [blitzTasks, taskGroups, getGroupTasks, taskGroupsHook, clearDrag]);


  // Toggle group folder expansion
  const toggleGroupExpanded = useCallback((groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // Mobile: manual move up/down (replaces drag on touch devices)
  const handleMoveTask = useCallback((groupId: string, index: number, direction: "up" | "down") => {
    const group = taskGroups.find(g => g.id === groupId);
    if (!group) return;
    const groupTaskList = getGroupTasks(group);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= groupTaskList.length) return;
    const srcTask = groupTaskList[index];
    const tgtTask = groupTaskList[targetIndex];
    // Swap positions in the full slot list to preserve hidden (filtered-out) tasks
    const newSlots = group.slots.map(s => {
      if (s.project_id === srcTask.projectId && s.task_id === srcTask.task.id) {
        const tgtSlot = group.slots.find(ts => ts.project_id === tgtTask.projectId && ts.task_id === tgtTask.task.id);
        return { ...s, position: tgtSlot?.position ?? s.position };
      }
      if (s.project_id === tgtTask.projectId && s.task_id === tgtTask.task.id) {
        const srcSlot = group.slots.find(ss => ss.project_id === srcTask.projectId && ss.task_id === srcTask.task.id);
        return { ...s, position: srcSlot?.position ?? s.position };
      }
      return s;
    }).sort((a, b) => a.position - b.position);
    taskGroupsHook.setSlots(groupId, newSlots);
  }, [taskGroups, getGroupTasks, taskGroupsHook]);

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
    // Find the BlitzTask to get projectType — more reliable than checking branch.
    const ctxBlitzTask = filteredTasks.find(
      (bt) => bt.task.id === pageState.contextMenu!.task.id,
    );
    const isStudioTask = ctxBlitzTask?.projectType === "studio";
    const items = buildContextMenuItems(pageState.contextMenu.task, {
      onEnterTerminal: () => {
        if (currentSelected) handleDoubleClickTask(currentSelected);
      },
      onCommit: isStudioTask ? undefined : opsHandlers.handleCommit,
      onRebase: isStudioTask ? undefined : opsHandlers.handleRebase,
      onSync: isStudioTask ? undefined : opsHandlers.handleSync,
      onMerge: isStudioTask ? undefined : opsHandlers.handleMerge,
      onArchive: opsHandlers.handleArchive,
      onReset: isStudioTask ? undefined : opsHandlers.handleReset,
      onClean: isStudioTask ? undefined : opsHandlers.handleClean,
    } as TaskOperationHandlers);

    // Add "Move to group" options for all tasks
    const task = pageState.contextMenu.task;
    const bt = blitzTasks.find(b => b.task.id === task.id);
    if (bt) {
      const taskKey = `${bt.projectId}:${task.id}`;
      // Find which group the task is currently in
      const currentGroup = taskGroups.find(g => g.slots.some(s => `${s.project_id}:${s.task_id}` === taskKey));
      // Show "Move to" options for groups the task is NOT in
      const availableGroups = taskGroups.filter(g => g.id !== currentGroup?.id);
      if (availableGroups.length > 0) {
        items.push({ id: "div-group", label: "", divider: true, onClick: () => {} });
        for (const group of availableGroups) {
          const label = group.id === MAIN_GROUP_ID ? "Main" : group.id === LOCAL_GROUP_ID ? "Local" : group.name;
          const icon = group.id === LOCAL_GROUP_ID ? Laptop : Folder;
          items.push({
            id: `move-to-group-${group.id}`,
            label: `Move to ${label}`,
            icon,
            variant: "default" as const,
            onClick: () => {
              if (currentGroup) {
                taskGroupsHook.moveTask(currentGroup.id, group.id, bt.projectId, task.id);
              }
            },
          });
        }
      }
    }
    return items;
  }, [pageState.contextMenu, opsHandlers, handleDoubleClickTask, currentSelected, taskGroups, blitzTasks, taskGroupsHook, filteredTasks]);

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
      // Panel shortcuts in the task-LIST view: enter workspace + open panel.
      // In-workspace panel + git op shortcuts are registered by TaskView
      // itself so every host page has consistent behavior.
      { key: "r", handler: () => handleAddPanelFromInfo("review"), options: { enabled: hasTask && isActive && notInWorkspace } },
      { key: "e", handler: () => handleAddPanelFromInfo("editor"), options: { enabled: hasTask && isActive && notInWorkspace } },
      { key: "i", handler: () => handleAddPanelFromInfo("chat"), options: { enabled: hasTask && isActive && notInWorkspace } },
      { key: "t", handler: () => handleAddPanelFromInfo("terminal"), options: { enabled: hasTask && isActive && notInWorkspace } },

      // Search
      { key: "/", handler: () => searchInputRef.current?.focus(), options: { enabled: notInWorkspace } },

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
  useEffect(() => {
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
  });

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
        <div className="p-4 flex items-center justify-between">
          <LogoBrand mode="blitz" onToggle={onSwitchToZen} />
          <button
            onClick={() => setShowRadioConnect(true)}
            className={`relative flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded-lg transition-colors ${
              radioConnected
                ? "text-[var(--color-success)] border-[var(--color-success)]/30 bg-[var(--color-success)]/10 hover:bg-[var(--color-success)]/20"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] border-[var(--color-border)]"
            }`}
            title={radioConnected ? `Radio Connected (${radioClients} device${radioClients > 1 ? "s" : ""})` : "Connect Radio (Walkie-Talkie)"}
          >
            <Radio className="w-3.5 h-3.5" />
            Radio
            {radioConnected && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse" />
            )}
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pt-3 pb-2 border-b border-[var(--color-border)]">
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
              {/* Main task list — universal drop zone */}
              <div
                ref={mainListRef}
                onDragOver={(e) => handleZoneDragOver(e, "main", MAIN_GROUP_ID)}
                onDrop={handleDrop}
                onDragLeave={handleDragLeave}
                className={`flex flex-col gap-1.5 rounded-lg transition-colors ${
                  dragState.source && dragState.source !== "main" && dragState.overZone === "main" ? "bg-[var(--color-accent)]/5 ring-1 ring-[var(--color-accent)]/20 p-1" : ""
                }`}
              >
                {mainListTasks.map((bt, index) => {
                  const notif = getTaskNotification(bt.task.id);
                  const taskKey = `${bt.projectId}:${bt.task.id}`;
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
                        onDragStart={() => startDrag("main", index, taskKey, MAIN_GROUP_ID)}
                        onDragOver={(e: React.DragEvent) => handleItemDragOver(e, "main", index, MAIN_GROUP_ID)}
                        onDragEnd={clearDrag}
                        onDragLeave={handleDragLeave}
                        isDragging={dragState.taskKey === taskKey && dragState.source === "main"}
                        isDragOver={dragState.overZone === "main" && dragState.overIndex === index}
                        onMoveUp={() => handleMoveTask(MAIN_GROUP_ID, index, "up")}
                        onMoveDown={() => handleMoveTask(MAIN_GROUP_ID, index, "down")}
                        isFirst={index === 0}
                        isLast={index === mainListTasks.length - 1}
                      />
                    </motion.div>
                  );
                })}
              </div>

              {/* TaskGroup Folders */}
              {customGroups.map((group) => {
                const groupTasks = getGroupTasks(group);
                const isExpanded = expandedGroups.has(group.id);
                const isDragOverThis = dragState.overZone === "group" && dragState.overGroupId === group.id;
                return (
                  <div
                    key={group.id}
                    className={`mt-1 rounded-lg transition-colors ${
                      isDragOverThis ? "bg-[var(--color-highlight)]/10 ring-1 ring-[var(--color-highlight)]/30" : ""
                    }`}
                    onDragOver={(e) => handleZoneDragOver(e, "group", group.id)}
                    onDrop={handleDrop}
                    onDragLeave={handleDragLeave}
                  >
                    {editingGroupId === group.id ? (
                      <div className="flex items-center gap-2 px-3 py-2">
                        <Folder className="w-3.5 h-3.5 text-[var(--color-highlight)]" />
                        <input
                          ref={editGroupInputRef}
                          type="text"
                          value={editingGroupName}
                          onChange={(e) => setEditingGroupName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && editingGroupName.trim()) {
                              updateTaskGroup(group.id, { name: editingGroupName.trim() });
                              setEditingGroupId(null);
                            } else if (e.key === "Escape") {
                              setEditingGroupId(null);
                            }
                          }}
                          onBlur={() => {
                            if (editingGroupName.trim() && editingGroupName.trim() !== group.name) {
                              updateTaskGroup(group.id, { name: editingGroupName.trim() });
                            }
                            setEditingGroupId(null);
                          }}
                          autoFocus
                          className="flex-1 min-w-0 px-2 py-0.5 rounded-md text-xs bg-[var(--color-bg)] border border-[var(--color-highlight)] text-[var(--color-text)] outline-none"
                        />
                      </div>
                    ) : (
                      <button
                        onClick={() => toggleGroupExpanded(group.id)}
                        onDoubleClick={() => {
                          setEditingGroupId(group.id);
                          setEditingGroupName(group.name);
                          setTimeout(() => editGroupInputRef.current?.select(), 50);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setGroupFolderContextMenu({
                            id: group.id,
                            name: group.name,
                            position: { x: e.clientX, y: e.clientY },
                          });
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                        title="Double-click to rename, right-click for options"
                      >
                        <motion.span
                          animate={{ rotate: isExpanded ? 90 : 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </motion.span>
                        <Folder className="w-3.5 h-3.5 text-[var(--color-highlight)]" />
                        <span>{group.name}</span>
                        <span className="ml-auto px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[10px]">
                          {groupTasks.length}
                        </span>
                      </button>
                    )}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden"
                        >
                          <div className="flex flex-col gap-1.5 pt-1.5 pl-2">
                            {groupTasks.length === 0 ? (
                              <div className="px-3 py-2 text-[10px] text-[var(--color-text-muted)] italic">
                                Drop tasks here to add them to this group
                              </div>
                            ) : (
                              groupTasks.map((bt, gIdx) => {
                                const notif = getTaskNotification(bt.task.id);
                                const isThisSelected =
                                  currentSelected?.task.id === bt.task.id &&
                                  currentSelected?.projectId === bt.projectId;
                                const taskKey = `${bt.projectId}:${bt.task.id}`;
                                return (
                                  <BlitzTaskListItem
                                    key={`group-${group.id}-${bt.projectId}-${bt.task.id}`}
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
                                    onDragStart={() => startDrag("group", gIdx, taskKey, group.id)}
                                    onDragOver={(e: React.DragEvent) => handleItemDragOver(e, "group", gIdx, group.id)}
                                    onDragEnd={clearDrag}
                                    onDragLeave={handleDragLeave}
                                    isDragging={dragState.taskKey === taskKey && dragState.source === "group"}
                                    isDragOver={dragState.overZone === "group" && dragState.overGroupId === group.id && dragState.overIndex === gIdx}
                                  />
                                );
                              })
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}

              {/* New group button / input */}
              <div className="mt-1">
                {showNewGroupInput ? (
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Folder className="w-3.5 h-3.5 text-[var(--color-highlight)]" />
                    <input
                      ref={newGroupInputRef}
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newGroupName.trim()) {
                          createTaskGroup(newGroupName.trim());
                          setNewGroupName("");
                          setShowNewGroupInput(false);
                        } else if (e.key === "Escape") {
                          setNewGroupName("");
                          setShowNewGroupInput(false);
                        }
                      }}
                      onBlur={() => {
                        if (newGroupName.trim()) {
                          createTaskGroup(newGroupName.trim());
                        }
                        setNewGroupName("");
                        setShowNewGroupInput(false);
                      }}
                      placeholder="Group name..."
                      autoFocus
                      className="flex-1 min-w-0 px-2 py-0.5 rounded-md text-xs bg-[var(--color-bg)] border border-[var(--color-highlight)] text-[var(--color-text)] outline-none"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setShowNewGroupInput(true);
                      setTimeout(() => newGroupInputRef.current?.focus(), 50);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-bg-tertiary)] border border-dashed border-transparent hover:border-[var(--color-highlight)]/30 transition-all"
                    title="Create new group"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>New group</span>
                  </button>
                )}
              </div>

              {/* Collapsible Local Tasks folder */}
              {folderLocalTasks.length > 0 && (
                <div
                  className={`mt-1 rounded-lg transition-colors ${
                    dragState.overZone === "local" ? "bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]/30" : ""
                  }`}
                  onDragOver={(e) => handleZoneDragOver(e, "local", LOCAL_GROUP_ID)}
                  onDrop={handleDrop}
                  onDragLeave={handleDragLeave}
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
                            const taskKey = `${bt.projectId}:${bt.task.id}`;
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
                                onDragStart={() => startDrag("local", index, taskKey, LOCAL_GROUP_ID)}
                                onDragOver={(e: React.DragEvent) => handleItemDragOver(e, "local", index, LOCAL_GROUP_ID)}
                                onDragEnd={clearDrag}
                                onDragLeave={handleDragLeave}
                                isDragging={dragState.taskKey === taskKey && dragState.source === "local"}
                                isDragOver={dragState.overZone === "local" && dragState.overIndex === index}
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
            onClick={() => window.dispatchEvent(new Event("grove:open-help"))}
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
        <div className="h-full relative">
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
                      onClean={isStudioTask ? undefined : opsHandlers.handleClean}
                      onCommit={isStudioTask ? undefined : (currentSelected.task.status !== "archived" ? opsHandlers.handleCommit : undefined)}
                      onRebase={isStudioTask ? undefined : (currentSelected.task.status !== "archived" ? opsHandlers.handleRebase : undefined)}
                      onSync={isStudioTask ? undefined : (currentSelected.task.status !== "archived" ? opsHandlers.handleSync : undefined)}
                      onMerge={isStudioTask ? undefined : (currentSelected.task.status !== "archived" ? opsHandlers.handleMerge : undefined)}
                      onArchive={currentSelected.task.status !== "archived" ? opsHandlers.handleArchive : undefined}
                      onReset={isStudioTask ? undefined : (currentSelected.task.status !== "archived" ? opsHandlers.handleReset : undefined)}
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
                    className="h-full flex items-center justify-center border border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
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
                    ref={taskViewCallbackRef}
                    projectId={currentSelected.projectId}
                    task={currentSelected.task}
                    projectName={currentSelected.projectName}
                    fullscreen={isFullscreen}
                    onFullscreenChange={setIsFullscreen}
                    onBack={handleCloseTask}
                    onCommit={isStudioTask ? undefined : opsHandlers.handleCommit}
                    onRebase={isStudioTask ? undefined : opsHandlers.handleRebase}
                    onSync={isStudioTask ? undefined : opsHandlers.handleSync}
                    onMerge={isStudioTask ? undefined : opsHandlers.handleMerge}
                    onArchive={opsHandlers.handleArchive}
                    onClean={isStudioTask ? undefined : opsHandlers.handleClean}
                    onReset={isStudioTask ? undefined : opsHandlers.handleReset}
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

      <RadioConnectDialog
        open={effectiveShowRadioConnect}
        onClose={() => setShowRadioConnect(false)}
        onGoToSettings={() => {
          onSwitchToZen();
          onNavigate?.("ai");
        }}
      />

      {/* TaskGroup folder context menu */}
      <ContextMenu
        items={groupFolderContextMenu ? [
          {
            id: "rename-group",
            label: "Rename",
            variant: "default" as const,
            onClick: () => {
              setEditingGroupId(groupFolderContextMenu.id);
              setEditingGroupName(groupFolderContextMenu.name);
              setTimeout(() => editGroupInputRef.current?.select(), 50);
              setGroupFolderContextMenu(null);
            },
          },
          {
            id: "delete-group",
            label: "Delete",
            variant: "danger" as const,
            onClick: () => {
              setPendingDeleteGroup({ id: groupFolderContextMenu.id, name: groupFolderContextMenu.name });
              setGroupFolderContextMenu(null);
            },
          },
        ] : []}
        position={groupFolderContextMenu?.position ?? null}
        onClose={() => setGroupFolderContextMenu(null)}
      />

      {/* TaskGroup delete confirmation */}
      <ConfirmDialog
        isOpen={!!pendingDeleteGroup}
        title="Delete Group"
        message={`Delete group "${pendingDeleteGroup?.name}"? Tasks in this group will not be deleted.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (pendingDeleteGroup) {
            deleteTaskGroup(pendingDeleteGroup.id);
          }
          setPendingDeleteGroup(null);
        }}
        onCancel={() => setPendingDeleteGroup(null)}
      />
    </>
  );
}
