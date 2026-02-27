import { Circle, CheckCircle, AlertTriangle, XCircle, ChevronUp, ChevronDown } from "lucide-react";
import type { BlitzTask } from "../../data/types";
import type { TaskStatus } from "../../data/types";
import { useIsMobile } from "../../hooks";

interface BlitzTaskListItemProps {
  blitzTask: BlitzTask;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  notification?: { level: string };
  shortcutNumber?: number;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragEnd?: () => void;
  onDragLeave?: () => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
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
} {
  switch (status) {
    case "live":
      return { icon: Circle, color: "var(--color-success)", label: "Live" };
    case "idle":
      return { icon: Circle, color: "var(--color-text-muted)", label: "Idle" };
    case "merged":
      return { icon: CheckCircle, color: "#a855f7", label: "Merged" };
    case "conflict":
      return { icon: AlertTriangle, color: "var(--color-error)", label: "Conflict" };
    case "broken":
      return { icon: XCircle, color: "var(--color-error)", label: "Broken" };
    case "archived":
      return { icon: Circle, color: "var(--color-text-muted)", label: "Archived" };
  }
}

export function BlitzTaskListItem({
  blitzTask,
  isSelected,
  onClick,
  onDoubleClick,
  onContextMenu,
  notification,
  shortcutNumber,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragLeave,
  isDragging,
  isDragOver,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: BlitzTaskListItemProps) {
  const { task, projectName } = blitzTask;
  const statusConfig = getStatusConfig(task.status);
  const StatusIcon = statusConfig.icon;
  const { isTouchDevice } = useIsMobile();

  return (
    <div className="flex items-stretch gap-0">
    <button
      data-task-id={task.id}
      onClick={onClick}
      onDoubleClick={task.status !== "archived" ? onDoubleClick : undefined}
      onContextMenu={onContextMenu}
      draggable={!isTouchDevice}
      onDragStart={isTouchDevice ? undefined : (e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.();
      }}
      onDragOver={isTouchDevice ? undefined : (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver?.();
      }}
      onDragEnd={isTouchDevice ? undefined : onDragEnd}
      onDragLeave={isTouchDevice ? undefined : onDragLeave}
      className={`relative flex-1 min-w-0 text-left rounded-lg transition-all duration-150 overflow-hidden ${
        isSelected
          ? "px-4 py-3 bg-[var(--color-highlight)]/5"
          : "px-3 py-2.5 bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)]"
      } ${!isTouchDevice && isDragging ? "opacity-40 cursor-grabbing" : !isTouchDevice ? "cursor-grab" : ""} ${
        isDragOver ? "border-t-2 border-t-[var(--color-highlight)]" : ""
      }`}
      style={isSelected ? {
        border: "2px solid transparent",
        backgroundImage: `linear-gradient(var(--color-bg-secondary), var(--color-bg-secondary)), linear-gradient(135deg, var(--color-highlight), color-mix(in srgb, var(--color-highlight) 40%, white), var(--color-highlight))`,
        backgroundOrigin: "border-box",
        backgroundClip: "padding-box, border-box",
        boxShadow: `0 0 8px -2px var(--color-highlight)`,
      } : undefined}
    >
      {/* Selection sweep effect — single gentle left-to-right pass */}
      {isSelected && (
        <div
          key={`${task.id}-sweep`}
          className="absolute inset-0 pointer-events-none animate-[card-sweep_4s_ease-out_infinite]"
          style={{
            background: "linear-gradient(90deg, transparent 0%, var(--color-highlight) 45%, var(--color-highlight) 55%, transparent 100%)",
            opacity: 0.06,
          }}
        />
      )}
      <div className="relative flex items-start gap-2.5">
        {/* Status Icon */}
        <div className="flex-shrink-0 mt-0.5">
          <StatusIcon
            className="w-3 h-3"
            style={{
              color: statusConfig.color,
              fill: task.status === "live" ? statusConfig.color : "transparent",
            }}
          />
        </div>

        {/* Task Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              {shortcutNumber !== undefined && (
                <span
                  className="blitz-shortcut flex-shrink-0 text-xs font-bold px-1.5 py-0.5 rounded opacity-0 transition-opacity duration-100"
                  style={{
                    backgroundColor: 'var(--color-highlight)',
                    color: 'var(--color-bg)',
                    minWidth: '20px',
                    textAlign: 'center',
                  }}
                >
                  {shortcutNumber}
                </span>
              )}
              <span className={`text-sm font-medium truncate ${isSelected ? "text-[var(--color-highlight)]" : "text-[var(--color-text)]"}`}>
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
            <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap flex-shrink-0">
              {formatTimeAgo(task.updatedAt)}
            </span>
          </div>

          <div className="flex items-center gap-2 mt-1">
            {/* Project name badge */}
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] truncate max-w-[120px]">
              {projectName}
            </span>

            {/* Code changes */}
            <span className="text-xs">
              <span className="text-[var(--color-success)]">+{task.additions}</span>
              {" "}
              <span className="text-[var(--color-error)]">-{task.deletions}</span>
            </span>

            {/* Status label (only for non-live/idle states) */}
            {task.status !== "live" && task.status !== "idle" && (
              <span className="text-xs font-medium" style={{ color: statusConfig.color }}>
                {statusConfig.label}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
    {/* Mobile: up/down move buttons instead of drag */}
    {isTouchDevice && (
      <div className="flex flex-col justify-center gap-0.5 ml-1">
        <button
          onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }}
          disabled={isFirst}
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-30 disabled:pointer-events-none"
          aria-label="Move up"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }}
          disabled={isLast}
          className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-30 disabled:pointer-events-none"
          aria-label="Move down"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>
    )}
    </div>
  );
}
