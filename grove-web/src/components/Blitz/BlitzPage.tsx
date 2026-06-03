import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ArrowLeft, ChevronRight, ChevronLeft, Laptop, Radio, Plus, Folder, LayoutGrid } from "lucide-react";
import { TaskInfoPanel } from "../Tasks/TaskInfoPanel";
import { TaskView, type TaskViewHandle } from "../Tasks/TaskView";
import { CommitDialog, ConfirmDialog, DirtyBranchDialog, MergeDialog } from "../Dialogs";
import { RebaseDialog } from "../Tasks/dialogs";
import { ContextMenu } from "../ui/ContextMenu";
import { LogoBrand } from "../Layout/LogoBrand";
import { useNotifications, useCommandPalette } from "../../context";
import {
  useIsMobile,
  useTaskPageState,
  useTaskNavigation,
  usePostMergeArchive,
  useTaskOperations,
  useTaskGroups,
  useRadioEvents,
  buildCommands,
} from "../../hooks";
import { useCommand, useDefineCommand, useKeyboardScope, useContextKey, useHelpKeyDisplay } from "../../keyboard";
import { RadioConnectDialog } from "./RadioConnectDialog";
import { useBlitzTasks } from "./useBlitzTasks";
import { BlitzFlexWorkspace } from "./BlitzFlexWorkspace";
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

const isTauri = typeof window !== "undefined" && (
  "__TAURI__" in window ||
  "__TAURI_INTERNALS__" in window
);

const isMac = typeof navigator !== "undefined" && (
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
  /Mac|iPhone|iPad/i.test(navigator.platform || "")
);

const shouldAvoidTrafficLights = isTauri && isMac;

interface BlitzPageProps {
  onSwitchToZen: () => void;
  onNavigate?: (page: string) => void;
}

export function BlitzPage({ onSwitchToZen, onNavigate }: BlitzPageProps) {
  const { blitzTasks, isLoading, refresh } = useBlitzTasks();
  const { getTaskNotification, dismissNotification } = useNotifications();
  const { isMobile } = useIsMobile();
  const helpKey = useHelpKeyDisplay();

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
  const [gridMode, setGridMode] = useState(false);
  // Desktop-only: collapse the Blitz task-list sidebar to a slim rail so the
  // grid quadrants get the full width. Mirrors Zen's sidebar minimize; like
  // Zen it's in-memory (resets on reload), not persisted.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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

  // `selectedBlitzTask` is a snapshot from the click moment; `blitzTasks`
  // refreshes underneath us. `liveSelected` is the same task with its latest
  // fields, used by hooks that need fresh data. Falls back to the snapshot
  // whenever the lookup misses — mid-archive, mid-refresh, or after the task
  // has been permanently removed. Callers that perform a hard removal are
  // expected to clear `selectedBlitzTask` themselves (e.g. archive flow
  // calls `setSelectedBlitzTask(null)`); without that, keyboard ops can
  // still fire against the deleted task and get a 404 from the backend.
  const liveSelected = useMemo(() => {
    if (!selectedBlitzTask) return null;
    return (
      blitzTasks.find(
        (bt) =>
          bt.task.id === selectedBlitzTask.task.id &&
          bt.projectId === selectedBlitzTask.projectId,
      ) ?? selectedBlitzTask
    );
  }, [blitzTasks, selectedBlitzTask]);

  const activeProjectId = liveSelected?.projectId ?? null;
  const selectedTask = liveSelected?.task ?? null;

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

  // Search-aware live row. Null while the selected task is filtered out of
  // view by the search query — used for the highlighted-row check and the
  // info/workspace panels, which should hide when the task isn't on screen.
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

  // Listen for Command key press for quick navigation.
  // Cleanup is layered (keyup / blur / visibilitychange / 3s safety timer)
  // because the bare keyup-of-Meta path is unreliable on macOS: when Tauri
  // Overlay title-bar mode is on, the OS occasionally swallows the meta
  // keyup if a system shortcut intercepts it, leaving the body class stuck
  // and chips visible. Any one of the fallback triggers clears the class.
  useEffect(() => {
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;

    const clearChips = () => {
      document.body.classList.remove('blitz-command-pressed');
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = undefined;
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Visual-only: show the Cmd+1..0 chips on each task row while the
      // Command key is held. The actual jump bindings are catalog
      // commands (blitz.task.jump.{1..10}) registered below — keeps the
      // shortcuts rebindable in Settings.
      if (e.metaKey) {
        document.body.classList.add('blitz-command-pressed');
        if (safetyTimer) clearTimeout(safetyTimer);
        safetyTimer = setTimeout(clearChips, 3000);
      }

      // Grid toggle (Cmd/Ctrl+G) and grid Escape are catalog commands now —
      // `blitz.grid.toggle` / `blitz.grid.exit` registered below — so they're
      // rebindable, show in ⌘/ help, and respect scopes (no double-fire with
      // tasks.escape).
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Once Meta is released, clear regardless of which key fired the keyup.
      if (!e.metaKey) clearChips();
    };

    // App lost focus (Cmd+Tab, switched window) — Meta keyup never arrives.
    const handleBlur = () => clearChips();
    const handleVisibilityChange = () => {
      if (document.hidden) clearChips();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (safetyTimer) clearTimeout(safetyTimer);
      // Clean up class on unmount
      document.body.classList.remove('blitz-command-pressed');
    };
  }, []);

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
  const canOperate = isActive;
  const notInWorkspace = !pageState.inWorkspace;

  // --- Keyboard scopes & commands ---
  // Push `tasks` scope while the user is on the Blitz list surface.
  useKeyboardScope("tasks", !pageState.inWorkspace);

  // Publish taskSelected for the catalog (palette.task.* etc.). Mirrors the
  // same key TasksPage publishes; last-write wins, both reflect the same
  // semantic "user has a task highlighted somewhere".
  useContextKey("taskSelected", hasTask);
  // Gates blitz.grid.exit (Escape) so it only fires while the grid is showing.
  useContextKey("blitzGridActive", gridMode);

  const enabledTask = useCallback(() => hasTask, [hasTask]);
  const enabledOpenWorkspace = useCallback(
    () => !!selectedTask && selectedTask.status !== "archived",
    [selectedTask],
  );

  useCommand("task.selectNext", navHandlers.selectNextTask, [navHandlers]);
  useCommand("task.selectPrevious", navHandlers.selectPreviousTask, [navHandlers]);
  useCommand(
    "task.open",
    () => {
      if (!pageState.inWorkspace && selectedTask && selectedTask.status !== "archived") {
        pageHandlers.handleEnterWorkspace();
      }
    },
    { enabled: enabledOpenWorkspace },
    [pageState.inWorkspace, selectedTask, pageHandlers, enabledOpenWorkspace],
  );
  useCommand(
    "task.contextMenu",
    navHandlers.openContextMenuAtSelectedTask,
    { enabled: enabledTask },
    [navHandlers, enabledTask],
  );
  useCommand("task.search", () => searchInputRef.current?.focus(), []);

  // Grid workspace toggle + exit (replaces the old raw window keydown listener).
  // Both skip while a text surface is focused so the keyboard doesn't toggle the
  // grid mid-typing or steal Escape from a composer/picker (its own blur/close
  // handling runs instead) — matching the old raw handler's input skip.
  const notTypingEnabled = useCallback(() => {
    const a = document.activeElement as HTMLElement | null;
    return !(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable));
  }, []);
  useCommand("blitz.grid.toggle", () => setGridMode((v) => !v), { enabled: notTypingEnabled }, [notTypingEnabled]);
  useCommand("blitz.grid.exit", () => setGridMode(false), { enabled: notTypingEnabled }, [notTypingEnabled]);

  // Task lifecycle commands (catalog: workspace scope) — Blitz doesn't show
  // archived tasks so task.unarchive isn't wired here; Zen owns it. Studio
  // tasks have no clean/reset semantics; gated via isStudioTask.
  const isArchived = selectedTask?.status === "archived";
  const enabledArchiveCmd = useCallback(
    () => hasTask && !isArchived && canOperate,
    [hasTask, isArchived, canOperate],
  );
  const enabledResetCmd = useCallback(
    () => hasTask && canOperate && !isStudioTask,
    [hasTask, canOperate, isStudioTask],
  );
  const enabledCleanCmd = useCallback(
    () => hasTask && !isStudioTask,
    [hasTask, isStudioTask],
  );
  useCommand("task.rename", opsHandlers.handleRename, { enabled: enabledTask }, [opsHandlers, enabledTask]);
  useCommand("task.archive", () => { void opsHandlers.handleArchive(); }, { enabled: enabledArchiveCmd }, [opsHandlers, enabledArchiveCmd]);
  useCommand("task.reset", opsHandlers.handleReset, { enabled: enabledResetCmd }, [opsHandlers, enabledResetCmd]);
  useCommand("task.clean", opsHandlers.handleClean, { enabled: enabledCleanCmd }, [opsHandlers, enabledCleanCmd]);

  // Cmd+1..0 → jump to the Nth main-list task. The body class for the
  // shortcut hint chips is still maintained by the raw keydown/keyup
  // listener above (visual hover state, not a binding); the jump action
  // itself is now catalog-driven via blitz.task.jump1..10 (Mod+1..0).
  const jumpToTaskAt = useCallback((index: number) => {
    if (index >= mainListTasks.length) return;
    const target = mainListTasks[index];
    const notif = getTaskNotification(target.task.id);
    if (notif) dismissNotification(notif.project_id, notif.task_id);
    handleSelectTask(target);
  }, [mainListTasks, getTaskNotification, dismissNotification, handleSelectTask]);
  useCommand("blitz.task.jump1",  () => jumpToTaskAt(0), [jumpToTaskAt]);
  useCommand("blitz.task.jump2",  () => jumpToTaskAt(1), [jumpToTaskAt]);
  useCommand("blitz.task.jump3",  () => jumpToTaskAt(2), [jumpToTaskAt]);
  useCommand("blitz.task.jump4",  () => jumpToTaskAt(3), [jumpToTaskAt]);
  useCommand("blitz.task.jump5",  () => jumpToTaskAt(4), [jumpToTaskAt]);
  useCommand("blitz.task.jump6",  () => jumpToTaskAt(5), [jumpToTaskAt]);
  useCommand("blitz.task.jump7",  () => jumpToTaskAt(6), [jumpToTaskAt]);
  useCommand("blitz.task.jump8",  () => jumpToTaskAt(7), [jumpToTaskAt]);
  useCommand("blitz.task.jump9",  () => jumpToTaskAt(8), [jumpToTaskAt]);
  useCommand("blitz.task.jump10", () => jumpToTaskAt(9), [jumpToTaskAt]);

  // Info panel tabs (catalog: tasks scope)
  useCommand("infotab.stats.show", () => pageHandlers.setInfoPanelTab("stats"), { enabled: enabledTask }, [pageHandlers, enabledTask]);
  useCommand("infotab.git.show", () => pageHandlers.setInfoPanelTab("git"), { enabled: enabledTask }, [pageHandlers, enabledTask]);
  useCommand("infotab.notes.show", () => pageHandlers.setInfoPanelTab("notes"), { enabled: enabledTask }, [pageHandlers, enabledTask]);
  useCommand("infotab.comments.show", () => pageHandlers.setInfoPanelTab("comments"), { enabled: enabledTask }, [pageHandlers, enabledTask]);

  // Panel shortcuts in the task-LIST view: enter workspace + open panel.
  // Tasks-scope inline commands so they don't collide with TaskView's
  // workspace-scope panel.X.open handlers.
  useDefineCommand({
    id: "tasks.openPanel.review",
    name: "Open Review Panel (From List)",
    category: "Task Navigation",
    defaultBindings: [{ key: "r" }],
    scope: "tasks",
    hidden: true,
    handler: () => handleAddPanelFromInfo("review"),
    enabled: () => hasTask && isActive,
  }, [handleAddPanelFromInfo, hasTask, isActive]);
  useDefineCommand({
    id: "tasks.openPanel.editor",
    name: "Open Editor Panel (From List)",
    category: "Task Navigation",
    defaultBindings: [{ key: "e" }],
    scope: "tasks",
    hidden: true,
    handler: () => handleAddPanelFromInfo("editor"),
    enabled: () => hasTask && isActive,
  }, [handleAddPanelFromInfo, hasTask, isActive]);
  useDefineCommand({
    id: "tasks.openPanel.chat",
    name: "Open Chat Panel (From List)",
    category: "Task Navigation",
    defaultBindings: [{ key: "i" }],
    scope: "tasks",
    hidden: true,
    handler: () => handleAddPanelFromInfo("chat"),
    enabled: () => hasTask && isActive,
  }, [handleAddPanelFromInfo, hasTask, isActive]);
  useDefineCommand({
    id: "tasks.openPanel.terminal",
    name: "Open Terminal Panel (From List)",
    category: "Task Navigation",
    defaultBindings: [{ key: "t" }],
    scope: "tasks",
    hidden: true,
    handler: () => handleAddPanelFromInfo("terminal"),
    enabled: () => hasTask && isActive,
  }, [handleAddPanelFromInfo, hasTask, isActive]);

  // Escape: close workspace OR clear selection.
  useDefineCommand({
    id: "tasks.escape",
    name: "Close Workspace / Clear Selection",
    category: "Task Navigation",
    defaultBindings: [{ key: "Escape" }],
    scope: "tasks",
    hidden: true,
    handler: handleCloseTask,
    // In grid mode, blitz.grid.exit owns Escape — keep these mutually exclusive
    // so they never both fire when a task is also selected.
    enabled: () => !gridMode && (pageState.inWorkspace || hasTask),
  }, [handleCloseTask, pageState.inWorkspace, hasTask, gridMode]);

  // --- Workspace tab switching (Cmd+1-9, Cmd+W).
  const inWorkspace = pageState.inWorkspace;
  const isTauri = useMemo(() => !!((window as Window & { __TAURI__?: unknown }).__TAURI__), []);

  const makeTabSelectHandler = useCallback(
    (idx: number) => () => {
      taskViewRef.current?.selectTabByIndex(idx);
    },
    [],
  );
  useDefineCommand({
    id: "blitz.workspace.tab.select1",
    name: "Select Workspace Tab 1",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+1" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(0),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);
  useDefineCommand({
    id: "blitz.workspace.tab.select2",
    name: "Select Workspace Tab 2",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+2" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(1),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);
  useDefineCommand({
    id: "blitz.workspace.tab.select3",
    name: "Select Workspace Tab 3",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+3" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(2),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);
  useDefineCommand({
    id: "blitz.workspace.tab.select4",
    name: "Select Workspace Tab 4",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+4" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(3),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);
  useDefineCommand({
    id: "blitz.workspace.tab.select5",
    name: "Select Workspace Tab 5",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+5" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(4),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);
  useDefineCommand({
    id: "blitz.workspace.tab.select6",
    name: "Select Workspace Tab 6",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+6" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(5),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);
  useDefineCommand({
    id: "blitz.workspace.tab.select7",
    name: "Select Workspace Tab 7",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+7" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(6),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);
  useDefineCommand({
    id: "blitz.workspace.tab.select8",
    name: "Select Workspace Tab 8",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+8" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(7),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);
  useDefineCommand({
    id: "blitz.workspace.tab.select9",
    name: "Select Workspace Tab 9",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Mod+9" }],
    scope: "workspace",
    hidden: true,
    passThroughTextInput: true,
    handler: makeTabSelectHandler(8),
    enabled: () => inWorkspace,
  }, [inWorkspace, makeTabSelectHandler]);

  // Close active tab. Cmd+W in Tauri; Alt+W as a browser fallback.
  useCommand(
    "panel.closeActive",
    () => taskViewRef.current?.closeActiveTab(),
    { enabled: () => inWorkspace },
    [inWorkspace],
  );
  useDefineCommand({
    id: "blitz.workspace.tab.closeAlt",
    name: "Close Active Tab (Alt+W)",
    category: "Workspace Tabs",
    defaultBindings: [{ key: "Alt+w" }],
    scope: "workspace",
    hidden: true,
    handler: () => taskViewRef.current?.closeActiveTab(),
    enabled: () => inWorkspace && !isTauri,
  }, [inWorkspace, isTauri]);

  // Suppress unused-binding warnings — these mirror prior useHotkeys deps.
  void opsHandlers;
  void refresh;
  void canOperate;
  void notInWorkspace;

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
      {/* Blitz Sidebar — replaces the normal app sidebar.
         Desktop: floating glass-panel matching the Zen sidebar (top-3/left-3/
         bottom-3, w-72, rounded-2xl, z-40). Mobile keeps the original
         full-screen list-detail toggle since the floating-panel pattern
         doesn't fit small viewports. */}
      <aside
        className={
          isMobile
            ? `${mobileShowDetail ? "hidden" : "w-full h-full"} bg-[var(--color-bg)] flex flex-col flex-shrink-0`
            : `blitz-area glass-panel fixed top-3 bottom-3 left-3 z-40 rounded-2xl flex flex-col transition-[width] duration-200 ease-in-out ${
                sidebarCollapsed ? "w-[72px]" : "w-72"
              }`
        }
      >
        {/* Collapsed rail (desktop): mirrors Zen's collapsed sidebar — the
           drag strip up top, then the same bottom-pinned expand toggle (just a
           ChevronRight, styled identically to Zen's Collapse button). Full
           content is hidden while collapsed. */}
        {!isMobile && sidebarCollapsed && (
          <>
            <div className="pt-8" data-tauri-drag-region data-window-drag-strip />
            <div className="mt-auto px-2 pb-3">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setSidebarCollapsed(false)}
                aria-label="Expand sidebar"
                title="Expand sidebar"
                className="w-full flex items-center justify-center gap-3 px-3 py-2.5 mt-1 rounded-xl text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </motion.button>
            </div>
          </>
        )}
        {(isMobile || !sidebarCollapsed) && (
        <>
        {/* Logo + Mode Brand
           pt-8 clears macOS traffic lights when Tauri title bar is Overlay.
           data-tauri-drag-region gives double-click-maximize; data-window-drag-strip
           is what the App.tsx native mousedown listener uses to call startDragging()
           (the bare data-tauri-drag-region silently fails after the first drag when
           the webview is loaded from http://localhost). */}
        <div className={`px-4 pb-4 flex flex-col items-start gap-3 ${shouldAvoidTrafficLights ? "pt-8" : "pt-4"}`} data-tauri-drag-region data-window-drag-strip>
          <LogoBrand mode="blitz" onToggle={onSwitchToZen} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setGridMode((v) => !v)}
              aria-pressed={gridMode}
              className={`relative flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded-lg transition-colors whitespace-nowrap ${
                gridMode
                  ? "text-[var(--color-highlight)] border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/10 hover:bg-[var(--color-highlight)]/20"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] border-[var(--color-border)]"
              }`}
              title="Toggle grid workspace (⌘G)"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Grid view
            </button>
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
            Press <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">{helpKey}</kbd> for shortcuts
          </button>
        </div>

        {/* Collapse toggle — same affordance as the Zen sidebar (bottom-pinned
           "‹ Collapse" button) so the two modes feel continuous. Desktop only. */}
        {!isMobile && (
          <div className="px-2 pb-3">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setSidebarCollapsed(true)}
              className="w-full flex items-center justify-center gap-3 px-3 py-2.5 mt-1 rounded-xl text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              <span className="flex-1 text-left">Collapse</span>
            </motion.button>
          </div>
        )}
        </>
        )}
      </aside>

      {/* Main Content
         Desktop: floating card mirroring the sidebar. Uses flex+margin
         instead of `fixed` because BlitzPage's internal task-detail /
         workspace transitions rely on `absolute inset-0` motion divs —
         turning main into `fixed` breaks the containing-block chain for
         those motion children and leaves the main area blank. ml-[312px]
         clears the fixed sidebar (left-3 + w-72 + 12px buffer = 12+288+12);
         mt/mr/mb give the same 12px gap as the sidebar. Mobile keeps the original
         flex layout since the sidebar there is full-screen, not floating. */}
      <main
        className={
          isMobile
            ? `flex-1 overflow-hidden relative ${!mobileShowDetail ? "hidden" : ""}`
            : `blitz-area flex-1 mt-3 mr-3 mb-3 rounded-2xl bg-[var(--color-bg)] overflow-hidden relative transition-[margin] duration-200 ease-in-out ${
                sidebarCollapsed ? "ml-[96px]" : "ml-[312px]"
              }`
        }
        style={
          isMobile
            ? undefined
            : {
                boxShadow:
                  "0 1px 3px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06), 0 0 0 1px color-mix(in oklab, var(--color-border) 35%, transparent)",
              }
        }
      >
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
        {/* Hairline inner padding so child content doesn't get clipped by
           the main card's rounded-2xl corners. Matches Zen's workspace-mode
           p-2 (8px); Zen's non-workspace pages use p-6 instead. Blitz uses
           the same p-2 across all states because every Blitz inner view is
           a task-centric panel (no "breathing-room dashboard" page like Zen
           has). */}
        <div className="h-full relative p-2">
          {gridMode ? (
            <BlitzFlexWorkspace blitzTasks={blitzTasks} />
          ) : (
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
                    className="h-full flex items-center justify-center"
                  >
                    <div className="text-center">
                      <p className="text-[var(--color-text-muted)] mb-2">
                        Select a task to view details
                      </p>
                      <p className="text-sm text-[var(--color-text-muted)]">
                        Press <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg)] border-[var(--color-border)]">{helpKey}</kbd> for keyboard shortcuts
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
                  className="absolute inset-0"
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
          )}
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
