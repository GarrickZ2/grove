import { motion } from "framer-motion";
import { Circle, CheckCircle, AlertTriangle, XCircle, Archive, MoreVertical } from "lucide-react";
import { useIsMobile } from "../../../hooks";
import type { Task, TaskStatus } from "../../../data/types";

interface TaskListItemProps {
  task: Task;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  notification?: { level: string };
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1d ago";
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function getNotificationColor(level: string): string {
  switch (level) {
    case "critical":
      return "var(--color-error)";
    case "warn":
      return "var(--color-warning)";
    default:
      return "var(--color-info)";
  }
}

function getStatusConfig(status: TaskStatus): {
  icon: typeof Circle;
  color: string;
  label: string;
  pulse?: boolean;
} {
  switch (status) {
    case "live":
      return {
        icon: Circle,
        color: "var(--color-success)",
        label: "Live",
        pulse: true,
      };
    case "idle":
      return {
        icon: Circle,
        color: "var(--color-text-muted)",
        label: "Idle",
      };
    case "merged":
      return {
        icon: CheckCircle,
        color: "#a855f7",
        label: "Merged",
      };
    case "conflict":
      return {
        icon: AlertTriangle,
        color: "var(--color-error)",
        label: "Conflict",
      };
    case "broken":
      return {
        icon: XCircle,
        color: "var(--color-error)",
        label: "Broken",
      };
    case "archived":
      return {
        icon: Archive,
        color: "var(--color-text-muted)",
        label: "Archived",
      };
  }
}

export function TaskListItem({ task, isSelected, onClick, onDoubleClick, onContextMenu, notification }: TaskListItemProps) {
  const statusConfig = getStatusConfig(task.status);
  const StatusIcon = statusConfig.icon;
  const { isMobile, isTouchDevice } = useIsMobile();

  return (
    <motion.button
      data-task-id={task.id}
      whileHover={isTouchDevice ? undefined : { backgroundColor: "var(--color-bg-tertiary)" }}
      onClick={onClick}
      onDoubleClick={!isMobile && task.status !== "archived" ? onDoubleClick : undefined}
      onContextMenu={!isTouchDevice ? onContextMenu : undefined}
      className={`w-full text-left px-3 py-2.5 transition-colors ${
        isMobile ? "py-3" : ""
      } ${
        isSelected
          ? "bg-[var(--color-bg-tertiary)] border-l-2 border-l-[var(--color-highlight)]"
          : "border-l-2 border-l-transparent"
      }`}
    >
      <div className="flex items-start gap-2.5">
        {/* Status Icon */}
        <div className="relative flex-shrink-0 mt-0.5">
          <StatusIcon
            className="w-3 h-3"
            style={{
              color: statusConfig.color,
              fill: task.status === "live" ? statusConfig.color : "transparent"
            }}
          />
          {statusConfig.pulse && (
            <span className="absolute inset-0 animate-ping">
              <Circle
                className="w-3 h-3"
                style={{
                  fill: `${statusConfig.color}30`,
                  color: "transparent"
                }}
              />
            </span>
          )}
        </div>

        {/* Task Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-sm font-medium text-[var(--color-text)] truncate">
                {task.name}
              </span>
              {task.createdBy === "agent" && (
                <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--color-info)]/15 text-[var(--color-info)]">
                  Agent
                </span>
              )}
              {notification && (
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: getNotificationColor(notification.level) }}
                />
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">
                {formatTimeAgo(task.updatedAt)}
              </span>
              {/* Mobile: three-dot menu button */}
              {isTouchDevice && onContextMenu && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onContextMenu(e);
                  }}
                  className="p-1 -mr-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                  aria-label="Task actions"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 mt-1">
            {/* Code changes */}
            {task.status !== "archived" && (
              <span className="text-xs">
                <span className="text-[var(--color-success)]">+{task.additions}</span>
                {" "}
                <span className="text-[var(--color-error)]">-{task.deletions}</span>
              </span>
            )}

            {/* Status label (only for non-live/idle states) */}
            {task.status !== "live" && task.status !== "idle" && (
              <span
                className="text-xs font-medium"
                style={{ color: statusConfig.color }}
              >
                {statusConfig.label}
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.button>
  );
}
