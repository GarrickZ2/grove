import { useCallback } from "react";
import type { Task } from "../data/types";
import type { ContextMenuState } from "./useTaskPageState";

/**
 * Configuration for task navigation
 */
interface TaskNavigationConfig {
  tasks: Task[];
  selectedTask: Task | null;
  inWorkspace: boolean;
  onSelectTask: (task: Task) => void;
  setContextMenu: (menu: ContextMenuState | null) => void;
  /** Optional selector for lists containing task IDs from multiple projects. */
  taskSelector?: (task: Task) => string;
}

/**
 * Task navigation handlers
 */
interface TaskNavigationHandlers {
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
  const { tasks, selectedTask, inWorkspace, onSelectTask, setContextMenu, taskSelector } = config;

  const selectNextTask = useCallback(() => {
    if (tasks.length === 0 || inWorkspace) return;
    const currentIndex = selectedTask ? (taskSelector ? tasks.indexOf(selectedTask) : tasks.findIndex((t) => t.id === selectedTask.id)) : -1;
    const nextIndex = currentIndex < tasks.length - 1 ? currentIndex + 1 : 0;
    const nextTask = tasks[nextIndex];
    onSelectTask(nextTask);
    // Scroll the task into view
    const el = document.querySelector(taskSelector?.(nextTask) ?? `[data-task-id="${CSS.escape(nextTask.id)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [tasks, selectedTask, inWorkspace, onSelectTask, taskSelector]);

  const selectPreviousTask = useCallback(() => {
    if (tasks.length === 0 || inWorkspace) return;
    const currentIndex = selectedTask ? (taskSelector ? tasks.indexOf(selectedTask) : tasks.findIndex((t) => t.id === selectedTask.id)) : -1;
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : tasks.length - 1;
    const prevTask = tasks[prevIndex];
    onSelectTask(prevTask);
    const el = document.querySelector(taskSelector?.(prevTask) ?? `[data-task-id="${CSS.escape(prevTask.id)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [tasks, selectedTask, inWorkspace, onSelectTask, taskSelector]);

  const openContextMenuAtSelectedTask = useCallback(() => {
    if (!selectedTask) return;
    const el = document.querySelector(taskSelector?.(selectedTask) ?? `[data-task-id="${CSS.escape(selectedTask.id)}"]`);
    if (el) {
      const rect = el.getBoundingClientRect();
      setContextMenu({
        task: selectedTask,
        position: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      });
    }
  }, [selectedTask, setContextMenu, taskSelector]);

  return {
    selectNextTask,
    selectPreviousTask,
    openContextMenuAtSelectedTask,
  };
}
