import { TaskSearch } from "./TaskSearch";
import { TaskFilters } from "./TaskFilters";
import { TaskListItem } from "./TaskListItem";
import type { Task, TaskFilter } from "../../../data/types";

interface TaskSidebarProps {
  tasks: Task[];
  selectedTask: Task | null;
  filter: TaskFilter;
  searchQuery: string;
  onSelectTask: (task: Task) => void;
  onDoubleClickTask: (task: Task) => void;
  onFilterChange: (filter: TaskFilter) => void;
  onSearchChange: (query: string) => void;
}

export function TaskSidebar({
  tasks,
  selectedTask,
  filter,
  searchQuery,
  onSelectTask,
  onDoubleClickTask,
  onFilterChange,
  onSearchChange,
}: TaskSidebarProps) {
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
        {tasks.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-[var(--color-text-muted)]">No tasks found</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {tasks.map((task) => (
              <TaskListItem
                key={task.id}
                task={task}
                isSelected={selectedTask?.id === task.id}
                onClick={() => onSelectTask(task)}
                onDoubleClick={() => onDoubleClickTask(task)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
