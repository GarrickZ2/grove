import { Archive, MoreVertical, Laptop, Zap, Code, ChevronUp, ChevronDown } from "lucide-react";
import { useIsMobile } from "../../../hooks";
import type { DropPlacement } from "../../../hooks/useTaskReorder";
import type { Task } from "../../../data/types";

/** Manual-order wiring for one row; absent when the list can't be reordered. */
export interface TaskListItemReorder {
  dragProps: React.HTMLAttributes<HTMLElement> & { draggable?: boolean };
  isDragging: boolean;
  dropPlacement: DropPlacement | null;
  /** Touch devices: undefined disables the button (first / last row). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

interface TaskListItemProps {
  task: Task;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  notification?: { level: string };
  reorder?: TaskListItemReorder;
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

export function TaskListItem({ task, isSelected, onClick, onDoubleClick, onContextMenu, notification, reorder }: TaskListItemProps) {
  const { isMobile, isTouchDevice } = useIsMobile();

  return (
    <button
      data-task-id={task.id}
      onClick={onClick}
      onDoubleClick={!isMobile && task.status !== "archived" ? onDoubleClick : undefined}
      onContextMenu={!isTouchDevice ? onContextMenu : undefined}
      {...reorder?.dragProps}
      className={`relative w-full text-left px-3 py-2.5 transition-colors hover:bg-[var(--color-bg-tertiary)] ${
        reorder?.isDragging ? "opacity-40" : ""
      } ${
        reorder?.dropPlacement === "before" ? "shadow-[inset_0_2px_0_var(--color-highlight)]" : ""
      } ${
        reorder?.dropPlacement === "after" ? "shadow-[inset_0_-2px_0_var(--color-highlight)]" : ""
      } ${
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
              {/* Mobile: up/down instead of drag */}
              {isTouchDevice && reorder && (
                <>
                  <span
                    role="button"
                    aria-label="Move up"
                    aria-disabled={!reorder.onMoveUp}
                    onClick={(e) => { e.stopPropagation(); reorder.onMoveUp?.(); }}
                    className={`p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors ${reorder.onMoveUp ? "" : "opacity-30 pointer-events-none"}`}
                  >
                    <ChevronUp className="w-4 h-4" />
                  </span>
                  <span
                    role="button"
                    aria-label="Move down"
                    aria-disabled={!reorder.onMoveDown}
                    onClick={(e) => { e.stopPropagation(); reorder.onMoveDown?.(); }}
                    className={`p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors ${reorder.onMoveDown ? "" : "opacity-30 pointer-events-none"}`}
                  >
                    <ChevronDown className="w-4 h-4" />
                  </span>
                </>
              )}
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

            {/* Archived badge */}
            {task.status === "archived" && (
              <span
                className="flex items-center gap-1 text-xs font-medium"
                style={{ color: "var(--color-text-muted)" }}
              >
                <Archive className="w-3 h-3" />
                Archived
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
