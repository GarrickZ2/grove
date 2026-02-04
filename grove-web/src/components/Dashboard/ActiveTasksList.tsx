import { motion } from "framer-motion";
import { Circle, ArrowRight, GitBranch } from "lucide-react";
import type { Task } from "../../data/types";

interface ActiveTasksListProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ActiveTasksList({ tasks, onTaskClick }: ActiveTasksListProps) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] h-full">
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <h2 className="text-sm font-medium text-[var(--color-text)]">
            Active Tasks
          </h2>
        </div>
        <div className="text-center py-8">
          <Circle className="w-8 h-8 mx-auto text-[var(--color-text-muted)] mb-2" />
          <p className="text-sm text-[var(--color-text-muted)]">
            No active tasks
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden h-full">
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-medium text-[var(--color-text)]">
          Active Tasks
        </h2>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        {tasks.map((task, index) => (
          <motion.button
            key={task.id}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.03 }}
            onClick={() => onTaskClick(task)}
            className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-bg-tertiary)] transition-colors text-left group"
          >
            {/* Status indicator */}
            <div className="relative flex-shrink-0">
              <Circle className="w-2.5 h-2.5 fill-[var(--color-success)] text-[var(--color-success)]" />
              <span className="absolute inset-0 animate-ping">
                <Circle className="w-2.5 h-2.5 fill-[var(--color-success)]/30 text-transparent" />
              </span>
            </div>

            {/* Task info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--color-text)] truncate">
                  {task.name}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-[var(--color-text-muted)]">
                <GitBranch className="w-3 h-3" />
                <span className="truncate max-w-[120px]">{task.branch}</span>
                <span>•</span>
                <span className="text-[var(--color-success)]">+{task.additions}</span>
                <span className="text-[var(--color-error)]">-{task.deletions}</span>
              </div>
            </div>

            {/* Time */}
            <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap flex-shrink-0">
              {formatTimeAgo(task.updatedAt)}
            </span>

            {/* Arrow */}
            <ArrowRight className="w-3.5 h-3.5 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
          </motion.button>
        ))}
      </div>
    </div>
  );
}
