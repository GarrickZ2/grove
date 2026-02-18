import { useCallback } from "react";
import type { Task } from "../data/types";
import type { ContextMenuState } from "./useTaskPageState";

/**
 * Configuration for task navigation
 */
export interface TaskNavigationConfig {
  tasks: Task[];
  selectedTask: Task | null;
  viewMode: "list" | "info" | "terminal" | "chat";
  onSelectTask: (task: Task) => void;
  setViewMode: (mode: "list" | "info" | "terminal" | "chat") => void;
  setContextMenu: (menu: ContextMenuState | null) => void;
}

/**
 * Task navigation handlers
 */
export interface TaskNavigationHandlers {
  selectNextTask: () => void;
  selectPreviousTask: () => void;
  openContextMenuAtSelectedTask: () => void;
}

/**
 * Hook for handling task keyboard navigation (j/k) and context menu positioning
 *
 * @param config - Navigation configuration
 * @returns Navigation handlers
 */
export function useTaskNavigation(config: TaskNavigationConfig): TaskNavigationHandlers {
  const { tasks, selectedTask, viewMode, onSelectTask, setViewMode, setContextMenu } = config;

  const selectNextTask = useCallback(() => {
    if (tasks.length === 0) return;
    const currentIndex = selectedTask ? tasks.findIndex((t) => t.id === selectedTask.id) : -1;
    const nextIndex = currentIndex < tasks.length - 1 ? currentIndex + 1 : 0;
    const nextTask = tasks[nextIndex];
    onSelectTask(nextTask);
    if (viewMode === "list") setViewMode("info");
    // Scroll the task into view
    const el = document.querySelector(`[data-task-id="${nextTask.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [tasks, selectedTask, viewMode, onSelectTask, setViewMode]);

  const selectPreviousTask = useCallback(() => {
    if (tasks.length === 0) return;
    const currentIndex = selectedTask ? tasks.findIndex((t) => t.id === selectedTask.id) : -1;
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : tasks.length - 1;
    const prevTask = tasks[prevIndex];
    onSelectTask(prevTask);
    if (viewMode === "list") setViewMode("info");
    const el = document.querySelector(`[data-task-id="${prevTask.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [tasks, selectedTask, viewMode, onSelectTask, setViewMode]);

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
  }, [selectedTask, setContextMenu]);

  return {
    selectNextTask,
    selectPreviousTask,
    openContextMenuAtSelectedTask,
  };
}
