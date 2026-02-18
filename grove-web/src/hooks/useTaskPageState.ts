import { useState, useCallback } from "react";
import type { Task } from "../data/types";
import type { TabType } from "../components/Tasks/TaskInfoPanel";
import type { PanelType } from "../components/Tasks/PanelSystem/types";

/**
 * Context menu state
 */
export interface ContextMenuState {
  task: Task;
  position: { x: number; y: number };
}

/**
 * Task page state
 */
export interface TaskPageState {
  selectedTask: Task | null;
  inWorkspace: boolean;
  operationMessage: string | null;
  contextMenu: ContextMenuState | null;
  infoPanelTab: TabType;
  showHelp: boolean;
  searchQuery: string;
  pendingPanel: PanelType | null;
}

/**
 * Task page handlers
 */
export interface TaskPageHandlers {
  // Task selection
  handleSelectTask: (task: Task) => void;
  handleDoubleClickTask: (task: Task) => void;
  handleCloseTask: () => void;
  setSelectedTask: (task: Task | null) => void;

  // Workspace
  handleEnterWorkspace: () => void;
  setInWorkspace: (inWorkspace: boolean) => void;

  // Context menu
  handleContextMenu: (task: Task, e: React.MouseEvent) => void;
  closeContextMenu: () => void;
  setContextMenu: (menu: ContextMenuState | null) => void;

  // Message
  showMessage: (message: string) => void;

  // Other state setters
  setInfoPanelTab: (tab: TabType) => void;
  setShowHelp: (show: boolean) => void;
  setSearchQuery: (query: string) => void;
  setPendingPanel: (panel: PanelType | null) => void;
}

/**
 * Hook for managing task page state
 *
 * @returns [state, handlers]
 */
export function useTaskPageState(): [TaskPageState, TaskPageHandlers] {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [inWorkspace, setInWorkspace] = useState(false);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [infoPanelTab, setInfoPanelTab] = useState<TabType>("stats");
  const [showHelp, setShowHelp] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingPanel, setPendingPanel] = useState<PanelType | null>(null);

  // Handle single click - show Info Panel (stay in Task List page)
  const handleSelectTask = useCallback((task: Task) => {
    setSelectedTask(task);
    // inWorkspace remains unchanged
  }, []);

  // Handle double click - enter Workspace with default layout
  const handleDoubleClickTask = useCallback((task: Task) => {
    if (task.status === "archived") return;
    setSelectedTask(task);
    setInWorkspace(true);
  }, []);

  // Handle closing task view
  const handleCloseTask = useCallback(() => {
    if (inWorkspace) {
      // From Workspace, go back to Task List page (keep Info Panel open)
      setInWorkspace(false);
    } else {
      // From Info Panel, go back to Empty State
      setSelectedTask(null);
    }
  }, [inWorkspace]);

  // Handle entering Workspace
  const handleEnterWorkspace = useCallback(() => {
    if (selectedTask?.status === "archived") return;
    setInWorkspace(true);
  }, [selectedTask]);

  // Context menu handlers
  const handleContextMenu = useCallback((task: Task, e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedTask(task);
    setContextMenu({ task, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Show toast message
  const showMessage = useCallback((message: string) => {
    setOperationMessage(message);
    setTimeout(() => setOperationMessage(null), 3000);
  }, []);

  const state: TaskPageState = {
    selectedTask,
    inWorkspace,
    operationMessage,
    contextMenu,
    infoPanelTab,
    showHelp,
    searchQuery,
    pendingPanel,
  };

  const handlers: TaskPageHandlers = {
    handleSelectTask,
    handleDoubleClickTask,
    handleCloseTask,
    setSelectedTask,
    handleEnterWorkspace,
    setInWorkspace,
    handleContextMenu,
    closeContextMenu,
    setContextMenu,
    showMessage,
    setInfoPanelTab,
    setShowHelp,
    setSearchQuery,
    setPendingPanel,
  };

  return [state, handlers];
}
