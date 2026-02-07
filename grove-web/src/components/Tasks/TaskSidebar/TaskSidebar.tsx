import { Loader2 } from "lucide-react";
import { TaskSearch } from "./TaskSearch";
import { TaskFilters } from "./TaskFilters";
import { TaskListItem } from "./TaskListItem";
import { useNotifications } from "../../../context";
import type { Task, TaskFilter } from "../../../data/types";

interface TaskSidebarProps {
  tasks: Task[];
  selectedTask: Task | null;
  filter: TaskFilter;
  searchQuery: string;
  isLoading?: boolean;
  onSelectTask: (task: Task) => void;
  onDoubleClickTask: (task: Task) => void;
  onContextMenuTask?: (task: Task, e: React.MouseEvent) => void;
  onFilterChange: (filter: TaskFilter) => void;
  onSearchChange: (query: string) => void;
}

export function TaskSidebar({
  tasks,
  selectedTask,
  filter,
  searchQuery,
  isLoading = false,
  onSelectTask,
  onDoubleClickTask,
  onContextMenuTask,
  onFilterChange,
  onSearchChange,
}: TaskSidebarProps) {
  const { getTaskNotification, dismissNotification } = useNotifications();

  return (
    <div className="h-full flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Search */}
      <div className="p-3 border-b border-[var(--color-border)]">
        <TaskSearch value={searchQuery} onChange={onSearchChange} />
      </div>

      {/* Filters */}
      <div className="px-3 py-2 border-b border-[var(--color-border)]">
        <TaskFilters filter={filter} onChange={onFilterChange} />
      </div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 text-[var(--color-text-muted)] animate-spin" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-[var(--color-text-muted)]">No tasks found</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {tasks.map((task) => {
              const notif = getTaskNotification(task.id);
              return (
                <TaskListItem
                  key={task.id}
                  task={task}
                  isSelected={selectedTask?.id === task.id}
                  onClick={() => {
                    if (notif) {
                      dismissNotification(notif.project_id, notif.task_id);
                    }
                    onSelectTask(task);
                  }}
                  onDoubleClick={() => onDoubleClickTask(task)}
                  onContextMenu={onContextMenuTask ? (e) => onContextMenuTask(task, e) : undefined}
                  notification={notif ? { level: notif.level } : undefined}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
