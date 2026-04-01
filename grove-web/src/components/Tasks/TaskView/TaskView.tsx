import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  GitBranch,
  ArrowRight,
  GitCommit,
  GitMerge,
  RefreshCw,
  MoreHorizontal,
  GitBranchPlus,
  Archive,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { FlexLayoutContainer, type FlexLayoutContainerHandle } from "../PanelSystem";
import type { Task } from "../../../data/types";
import type { PanelType } from "../PanelSystem/types";

// --- Workspace Bar Dropdown (for overflow actions) ---
function OverflowDropdown({ items }: { items: OverflowItem[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 6, left: rect.right });
    }
    setIsOpen(!isOpen);
  };

  const getVariantClass = (variant?: string) => {
    switch (variant) {
      case "warning": return "text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10";
      case "danger": return "text-[var(--color-error)] hover:bg-[var(--color-error)]/10";
      default: return "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        title="More actions"
      >
        <MoreHorizontal size={15} />
      </button>
      {isOpen && createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            transform: "translateX(-100%)",
            zIndex: 10000,
          }}
          className="min-w-[180px] p-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_12px_40px_rgba(0,0,0,0.18),0_4px_12px_rgba(0,0,0,0.08)]"
        >
          {items.map((item, i) => (
            <div key={item.id}>
              {item.separator && i > 0 && (
                <div className="h-px bg-[var(--color-border)] mx-2 my-1" />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!item.disabled) { item.onClick(); setIsOpen(false); }
                }}
                disabled={item.disabled}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] font-medium rounded-lg transition-colors ${getVariantClass(item.variant)} ${item.disabled ? "opacity-35 cursor-not-allowed" : ""}`}
              >
                <item.icon size={14} className="opacity-80 shrink-0" />
                <span className="flex-1">{item.label}</span>
                {item.shortcut && (
                  <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] leading-none">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

interface OverflowItem {
  id: string;
  label: string;
  icon: typeof GitCommit;
  onClick: () => void;
  shortcut?: string;
  variant?: "default" | "warning" | "danger";
  disabled?: boolean;
  separator?: boolean;
}

interface TaskViewProps {
  projectId: string;
  task: Task;
  projectName?: string;
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
  onBack?: () => void;
  onCommit: () => void;
  onRebase: () => void;
  onSync: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onClean: () => void;
  onReset: () => void;
}

export interface TaskViewHandle {
  addPanel: (type: PanelType) => void;
  selectTabByIndex: (index: number) => "handled" | "no_tabs" | "out_of_range";
  selectAdjacentTab: (delta: number) => boolean;
  closeActiveTab: () => void;
}

export const TaskView = forwardRef<TaskViewHandle, TaskViewProps>((props, ref) => {
  const {
    projectId,
    task,
    projectName,
    fullscreen: externalFullscreen,
    onFullscreenChange,
    onBack,
    onCommit,
    onRebase,
    onSync,
    onMerge,
    onArchive,
    onClean,
    onReset,
  } = props;
  const layoutRef = useRef<FlexLayoutContainerHandle>(null);
  const fullscreen = externalFullscreen ?? false;
  const toggleFullscreen = () => onFullscreenChange?.(!fullscreen);

  const handleAddPanel = useCallback((type: PanelType) => {
    layoutRef.current?.addPanel(type);
  }, []);

  useImperativeHandle(ref, () => ({
    addPanel: handleAddPanel,
    selectTabByIndex: (index: number) => layoutRef.current?.selectTabByIndex(index) ?? "no_tabs",
    selectAdjacentTab: (delta: number) => layoutRef.current?.selectAdjacentTab(delta) ?? false,
    closeActiveTab: () => layoutRef.current?.closeActiveTab(),
  }), [handleAddPanel]);

  // Overflow menu items
  const isArchived = task.status === "archived";
  const isBroken = task.status === "broken";
  const isLocal = task.isLocal === true;
  const canOperate = !isArchived && !isBroken && !isLocal;

  const overflowItems: OverflowItem[] = [
    ...(!isLocal ? [{
      id: "rebase", label: "Rebase", icon: GitBranchPlus, onClick: onRebase,
      shortcut: "b", disabled: !canOperate,
    }] : []),
    ...(!isLocal ? [{
      id: "archive", label: "Archive", icon: Archive, onClick: onArchive,
      shortcut: "a", variant: "warning" as const, disabled: isBroken || isArchived, separator: true,
    }] : []),
    {
      id: "reset", label: "Reset", icon: RotateCcw, onClick: onReset,
      shortcut: "x", variant: "warning" as const, disabled: isArchived,
      separator: isLocal,
    },
    {
      id: "clean", label: "Clean", icon: Trash2, onClick: onClean,
      shortcut: "⇧X", variant: "danger" as const,
    },
  ];

  return (
    <div className={`flex-1 flex flex-col h-full overflow-hidden ${fullscreen ? 'fixed inset-0 z-50 bg-[var(--color-bg)]' : ''}`}>
      {/* Workspace Bar — hidden in fullscreen */}
      {!fullscreen && <div className="flex items-center h-9 px-3 gap-3 bg-[var(--color-bg)] border-b border-[var(--color-border)] shrink-0 select-none">
        {/* Left: Back + Breadcrumb + Branch */}
        <div className="flex items-center gap-2.5 min-w-0 text-[12.5px]">
          {/* Back button (hidden when onBack is not provided, e.g. localMode) */}
          {onBack && (
            <button
              onClick={onBack}
              className="flex items-center gap-1 h-7 px-2 rounded-md text-[var(--color-text)]/50 hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors shrink-0"
              title="Back (Esc)"
            >
              <ArrowLeft size={13} />
              <span className="text-xs font-medium">Back</span>
            </button>
          )}

          {/* Breadcrumb: project › task (skip project for local tasks) */}
          <div className="flex items-center gap-1.5 min-w-0">
            {projectName && !task.isLocal && (
              <>
                <span className="text-[var(--color-highlight)] truncate">{projectName}</span>
                <span className="text-[var(--color-text-muted)]">›</span>
              </>
            )}
            <span className="font-medium text-[var(--color-highlight)] truncate">{task.name}</span>
          </div>

          {/* Branch info — accent color */}
          <div className="flex items-center gap-1.5 text-[var(--color-accent)] shrink-0 opacity-75">
            <GitBranch size={13} />
            <span className="font-mono">{task.branch}</span>
            {!task.isLocal && (
              <>
                <ArrowRight size={11} />
                <span className="font-mono">{task.target}</span>
              </>
            )}
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right: Git Actions + Overflow + CmdK + Fullscreen */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Git Actions — direct buttons */}
          <button
            onClick={onCommit}
            disabled={isArchived}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
            title="Commit (c)"
          >
            <GitCommit size={13} />
            <span>Commit</span>
          </button>
          <button
            onClick={onMerge}
            disabled={!canOperate}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
            title="Merge (m)"
          >
            <GitMerge size={13} />
            <span>Merge</span>
          </button>
          {!isLocal && (
            <button
              onClick={onSync}
              disabled={!canOperate}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
              title="Sync (s)"
            >
              <RefreshCw size={13} />
              <span>Sync</span>
            </button>
          )}

          {/* Separator */}
          <div className="w-px h-4 bg-[var(--color-border)] mx-1" />

          {/* Overflow: Rebase, Archive, Reset, Clean */}
          {overflowItems.length > 0 && <OverflowDropdown items={overflowItems} />}

        </div>
      </div>}

      {/* FlexLayout — fills remaining space */}
      <div className="flex-1 min-h-0 relative">
        <FlexLayoutContainer
          ref={layoutRef}
          task={task}
          projectId={projectId}
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
        />
      </div>
    </div>
  );
});

TaskView.displayName = "TaskView";
