import { useState, useCallback } from "react";
import type { Task } from "../data/types";
import type { TabType } from "../components/Tasks/TaskInfoPanel";

type ViewMode = "list" | "info" | "terminal";

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
  viewMode: ViewMode;
  operationMessage: string | null;
  contextMenu: ContextMenuState | null;
  infoPanelTab: TabType;
  showHelp: boolean;
  reviewOpen: boolean;
  editorOpen: boolean;
  searchQuery: string;
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

  // View mode
  handleEnterTerminal: () => void;
  setViewMode: (mode: ViewMode) => void;

  // Panels (Review/Editor)
  handleToggleReview: () => void;
  handleToggleEditor: () => void;
  handleReviewFromInfo: () => void;
  handleEditorFromInfo: () => void;

  // Unified shortcut handlers
  handleReviewShortcut: () => void;
  handleEditorShortcut: () => void;
  handleTerminalShortcut: () => void;

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
  setReviewOpen: (open: boolean) => void;
  setEditorOpen: (open: boolean) => void;
}

/**
 * Hook for managing task page state
 *
 * @returns [state, handlers]
 */
export function useTaskPageState(): [TaskPageState, TaskPageHandlers] {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [infoPanelTab, setInfoPanelTab] = useState<TabType>("stats");
  const [showHelp, setShowHelp] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Handle single click - show Info Panel
  const handleSelectTask = useCallback((task: Task) => {
    setSelectedTask(task);
    setViewMode("info");
    setReviewOpen(false);
    setEditorOpen(false);
  }, []);

  // Handle double click - enter Terminal mode (only for non-archived tasks)
  const handleDoubleClickTask = useCallback((task: Task) => {
    if (task.status === "archived") return;
    setSelectedTask(task);
    setViewMode("terminal");
    setReviewOpen(false);
    setEditorOpen(false);
  }, []);

  // Handle closing task view - return to previous mode
  const handleCloseTask = useCallback(() => {
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
  }, [viewMode]);

  // Handle entering terminal mode from info panel (only for non-archived tasks)
  const handleEnterTerminal = useCallback(() => {
    if (selectedTask?.status === "archived") return;
    setViewMode("terminal");
  }, [selectedTask]);

  // Handle toggle review (mutual exclusion with editor)
  const handleToggleReview = useCallback(() => {
    if (!reviewOpen) setEditorOpen(false);
    setReviewOpen(!reviewOpen);
  }, [reviewOpen]);

  // Handle toggle editor (mutual exclusion with review)
  const handleToggleEditor = useCallback(() => {
    if (!editorOpen) setReviewOpen(false);
    setEditorOpen(!editorOpen);
  }, [editorOpen]);

  // Handle review from info mode - enter terminal mode with review panel open
  const handleReviewFromInfo = useCallback(() => {
    setViewMode("terminal");
    setReviewOpen(true);
    setEditorOpen(false);
  }, []);

  // Handle editor from info mode - enter terminal mode with editor panel open
  const handleEditorFromInfo = useCallback(() => {
    setViewMode("terminal");
    setEditorOpen(true);
    setReviewOpen(false);
  }, []);

  // Unified review handler - works in both info and terminal modes
  const handleReviewShortcut = useCallback(() => {
    if (viewMode === "terminal") {
      handleToggleReview();
    } else {
      handleReviewFromInfo();
    }
  }, [viewMode, handleToggleReview, handleReviewFromInfo]);

  // Unified editor handler - works in both info and terminal modes
  const handleEditorShortcut = useCallback(() => {
    if (viewMode === "terminal") {
      handleToggleEditor();
    } else {
      handleEditorFromInfo();
    }
  }, [viewMode, handleToggleEditor, handleEditorFromInfo]);

  // Terminal shortcut - toggle between terminal and info modes
  const handleTerminalShortcut = useCallback(() => {
    if (viewMode === "terminal") {
      // If review or editor is open, close them
      if (reviewOpen || editorOpen) {
        setReviewOpen(false);
        setEditorOpen(false);
      } else {
        // If pure terminal mode, go back to info mode
        setViewMode("info");
      }
    } else {
      // In other modes, switch to terminal mode
      setViewMode("terminal");
      setReviewOpen(false);
      setEditorOpen(false);
    }
  }, [viewMode, reviewOpen, editorOpen]);

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
    viewMode,
    operationMessage,
    contextMenu,
    infoPanelTab,
    showHelp,
    reviewOpen,
    editorOpen,
    searchQuery,
  };

  const handlers: TaskPageHandlers = {
    handleSelectTask,
    handleDoubleClickTask,
    handleCloseTask,
    setSelectedTask,
    handleEnterTerminal,
    setViewMode,
    handleToggleReview,
    handleToggleEditor,
    handleReviewFromInfo,
    handleEditorFromInfo,
    handleReviewShortcut,
    handleEditorShortcut,
    handleTerminalShortcut,
    handleContextMenu,
    closeContextMenu,
    setContextMenu,
    showMessage,
    setInfoPanelTab,
    setShowHelp,
    setSearchQuery,
    setReviewOpen,
    setEditorOpen,
  };

  return [state, handlers];
}
