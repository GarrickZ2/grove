import { useLayoutEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import type { BlitzTask } from "../../data/types";
import { useIsMobile } from "../../hooks";
import { Tooltip } from "../ui/Tooltip";

interface BlitzTaskListItemProps {
  blitzTask: BlitzTask;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  notification?: { level: string };
  shortcutNumber?: number;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDragLeave?: () => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  dragPlacement?: "before" | "after" | null;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
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

interface MiddleEllipsisProps {
  text: string;
  className?: string;
}

let sharedTextMeasureContext: CanvasRenderingContext2D | null = null;

function getTextMeasureContext(): CanvasRenderingContext2D | null {
  if (sharedTextMeasureContext) return sharedTextMeasureContext;
  sharedTextMeasureContext = document.createElement("canvas").getContext("2d");
  return sharedTextMeasureContext;
}

/**
 * Preserve both ends of identifiers instead of dropping the distinguishing
 * suffix. The visible string is recalculated from the actual rendered width,
 * font, and letter spacing whenever the sidebar is resized.
 */
function MiddleEllipsis({ text, className }: MiddleEllipsisProps) {
  const elementRef = useRef<HTMLSpanElement | null>(null);
  const [visibleText, setVisibleText] = useState(text);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const context = getTextMeasureContext();
    if (!context) return;

    const update = () => {
      const availableWidth = element.clientWidth;
      if (availableWidth <= 0) return;

      const style = window.getComputedStyle(element);
      context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const parsedLetterSpacing = Number.parseFloat(style.letterSpacing);
      const letterSpacing = Number.isFinite(parsedLetterSpacing) ? parsedLetterSpacing : 0;
      const measure = (value: string) => (
        context.measureText(value).width + Math.max(0, [...value].length - 1) * letterSpacing
      );

      if (measure(text) <= availableWidth) {
        setVisibleText(text);
        return;
      }

      const chars = [...text];
      const separator = "...";
      let best = separator;
      let low = 2;
      let high = chars.length - 1;

      while (low <= high) {
        const kept = Math.floor((low + high) / 2);
        const prefixLength = Math.ceil(kept / 2);
        const suffixLength = Math.floor(kept / 2);
        const candidate = `${chars.slice(0, prefixLength).join("")}${separator}${
          suffixLength > 0 ? chars.slice(-suffixLength).join("") : ""
        }`;

        if (measure(candidate) <= availableWidth) {
          best = candidate;
          low = kept + 1;
        } else {
          high = kept - 1;
        }
      }

      setVisibleText(best);
    };

    const observer = new ResizeObserver(update);
    observer.observe(element);
    void document.fonts?.ready.then(update);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span ref={elementRef} className={className} aria-label={text}>
      {visibleText}
    </span>
  );
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
  dragPlacement,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: BlitzTaskListItemProps) {
  const { task, projectName, projectType } = blitzTask;
  const { isTouchDevice } = useIsMobile();
  const isStudio = projectType === "studio";

  return (
    <div className="flex items-stretch gap-0">
      <button
        data-project-id={blitzTask.projectId}
        data-task-id={task.id}
        onClick={onClick}
        onDoubleClick={task.status !== "archived" ? onDoubleClick : undefined}
        onContextMenu={onContextMenu}
        draggable={!isTouchDevice}
        onDragStart={isTouchDevice ? undefined : (e) => {
          e.dataTransfer.effectAllowed = "move";
          onDragStart?.();
        }}
        onDragOver={isTouchDevice ? undefined : (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onDragOver?.(e);
        }}
        onDragEnd={isTouchDevice ? undefined : onDragEnd}
        onDragLeave={isTouchDevice ? undefined : onDragLeave}
        className={`relative flex-1 min-w-0 px-3 py-2.5 text-left rounded-lg overflow-hidden bg-[var(--color-bg-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-tertiary)] ${
          isSelected
            ? "bg-[var(--color-highlight)]/5 ring-2 ring-inset ring-[var(--color-highlight)]"
            : ""
        } ${!isTouchDevice && isDragging ? "opacity-40 cursor-grabbing" : !isTouchDevice ? "cursor-grab" : ""} ${
          isDragOver && dragPlacement === "before" ? "border-t-2 border-t-[var(--color-highlight)]" : ""
        } ${
          isDragOver && dragPlacement === "after" ? "border-b-2 border-b-[var(--color-highlight)]" : ""
        }`}
      >
        {notification && (
          <span
            className="absolute inset-y-2 right-0 w-0.5 rounded-l"
            style={{ backgroundColor: getNotificationColor(notification.level) }}
            aria-label={`${notification.level} notification`}
          />
        )}

        {shortcutNumber !== undefined && (
          <span
            className="blitz-shortcut absolute right-2 top-2 z-10 min-w-5 rounded px-1.5 py-0.5 text-center text-xs font-bold opacity-0"
            style={{
              backgroundColor: "var(--color-highlight)",
              color: "var(--color-bg)",
            }}
          >
            {shortcutNumber}
          </span>
        )}

        <Tooltip content={task.name} position="right" className="block w-full min-w-0 max-w-full">
          <MiddleEllipsis
            text={task.name}
            className={`block w-full min-w-0 max-w-full overflow-hidden whitespace-nowrap text-sm font-medium ${
              isSelected ? "text-[var(--color-highlight)]" : "text-[var(--color-text)]"
            }`}
          />
        </Tooltip>

        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span
            className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              isStudio
                ? "bg-[var(--color-warning)]/15 text-[var(--color-warning)]"
                : "bg-[var(--color-highlight)]/15 text-[var(--color-highlight)]"
            }`}
          >
            {isStudio ? "Studio" : "Code"}
          </span>
          <span
            className="min-w-0 truncate rounded border border-[var(--color-highlight)]/20 bg-[var(--color-bg-tertiary)]/60 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
            title={task.isLocal ? "Work" : projectName}
          >
            {task.isLocal ? "Work" : projectName}
          </span>
        </div>
      </button>

      {/* Mobile: up/down move buttons instead of drag */}
      {isTouchDevice && (
        <div className="ml-1 flex flex-col justify-center gap-0.5">
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
