import { Circle, CheckCircle, AlertTriangle, XCircle, Archive, MoreVertical, Laptop, Zap, Code } from "lucide-react";
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
  const { isMobile, isTouchDevice } = useIsMobile();

  return (
    <button
      data-task-id={task.id}
      onClick={onClick}
      onDoubleClick={!isMobile && task.status !== "archived" ? onDoubleClick : undefined}
      onContextMenu={!isTouchDevice ? onContextMenu : undefined}
      className={`w-full text-left px-3 py-2.5 transition-colors hover:bg-[var(--color-bg-tertiary)] ${
        isMobile ? "py-3" : ""
      } ${
        isSelected
          ? task.isLocal
            ? "bg-[var(--color-bg-tertiary)] border-l-2 border-l-[var(--color-accent)]"
            : "bg-[var(--color-bg-tertiary)] border-l-2 border-l-[var(--color-highlight)]"
          : task.isLocal
            ? "border-l-2 border-l-[var(--color-accent)]/30"
            : "border-l-2 border-l-transparent"
      }`}
    >
      <div className="flex items-start gap-2.5">
        {/* Task type icon: Local=Laptop, Agent=Bot, Regular=Code */}
        <div className="relative flex-shrink-0 mt-0.5">
          {task.isLocal ? (
            <Laptop
              className="w-3.5 h-3.5"
              style={{ color: "var(--color-accent)" }}
            />
          ) : task.createdBy === "agent" ? (
            <Zap
              className="w-3.5 h-3.5"
              style={{ color: "var(--color-info)" }}
            />
          ) : (
            <Code
              className="w-3.5 h-3.5"
              style={{ color: "var(--color-highlight)" }}
            />
          )}
        </div>

        {/* Task Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-sm font-medium text-[var(--color-text)] truncate">
                {task.name}
              </span>
              {task.isLocal && (
                <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
                  Local
                </span>
              )}
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

          <div className="flex items-center gap-2 mt-1 min-h-[20px]">
            {/* Target branch label (non-local tasks only) */}
            {!task.isLocal && task.target && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] truncate max-w-[200px]">
                {task.target}
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
    </button>
  );
}
