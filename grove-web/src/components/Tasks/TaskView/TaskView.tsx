import { useState, useRef, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
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
import { IDELayoutContainer } from "../IDELayout";
import type { IDELayoutHandle, LayoutMode, AuxPanelType, InfoTabType } from "../IDELayout";
import { AUX_PANEL_TYPES, INFO_PANEL_TYPES } from "../IDELayout";
import type { Task } from "../../../data/types";
import type { PanelType } from "../PanelSystem/types";
import { sendInputToTerminal, pasteToTerminal } from "../TaskDetail/terminalCache";
import { useConfig } from "../../../context";
import { useHotkeys } from "../../../hooks";

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
  /** Git-dependent actions — pass `undefined` to hide the corresponding button. */
  onCommit?: () => void;
  onRebase?: () => void;
  onSync?: () => void;
  onMerge?: () => void;
  onArchive?: () => void;
  onClean?: () => void;
  onReset?: () => void;
}

export interface TaskViewHandle {
  addPanel: (type: PanelType) => void;
  /** Select an existing tab of this type, or create one if none exists. */
  ensurePanel: (type: PanelType) => void;
  selectTabByIndex: (index: number) => "handled" | "no_tabs" | "out_of_range";
  selectAdjacentTab: (delta: number) => boolean;
  closeActiveTab: () => void;
  /** Send text input to the task's terminal (via cached terminal WebSocket). */
  sendTerminalInput: (text: string) => boolean;
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
  const ideLayoutRef = useRef<IDELayoutHandle>(null);
  const { config } = useConfig();
  const layoutMode: LayoutMode = (config?.web?.workspace_layout === "flex" ? "flex" : "ide") as LayoutMode;
  const fullscreen = externalFullscreen ?? false;
  const toggleFullscreen = () => onFullscreenChange?.(!fullscreen);

  // Shared panel routing: delegates to the correct layout backend
  const routePanelCommand = useCallback((type: PanelType, flexAction: "add" | "ensure") => {
    if (layoutMode === "ide") {
      if ((AUX_PANEL_TYPES as readonly string[]).includes(type)) {
        ideLayoutRef.current?.focusAuxPanel(type as AuxPanelType);
      } else if ((INFO_PANEL_TYPES as readonly string[]).includes(type)) {
        ideLayoutRef.current?.focusInfoPanel(type as InfoTabType);
      } else if (type === "chat") {
        ideLayoutRef.current?.focusChat();
      }
    } else {
      const ref = layoutRef.current;
      if (flexAction === "add") ref?.addPanel(type);
      else ref?.ensurePanel(type);
    }
  }, [layoutMode]);

  const handleAddPanel = useCallback((type: PanelType) => routePanelCommand(type, "add"), [routePanelCommand]);
  const handleEnsurePanel = useCallback((type: PanelType) => routePanelCommand(type, "ensure"), [routePanelCommand]);

  const handleSendTerminalInput = useCallback((text: string): boolean => {
    // Terminal cache key prefix: "task:{projectId}:{taskId}|"
    const prefix = `task:${projectId}:${task.id}|`;
    return sendInputToTerminal(prefix, text);
  }, [projectId, task.id]);

  // Handle "Run in Terminal" events from ACP Chat markdown code blocks.
  // Flow: always create a NEW Terminal tab → switch to Terminal panel → paste
  // command via bracketed paste (shell treats it as a paste, so multi-line
  // content sits on the prompt without auto-executing; user still presses
  // Enter to run).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ command: string }>).detail;
      if (!detail?.command) return;

      if (layoutMode === "ide") {
        const newTabId = ideLayoutRef.current?.addTerminalTab();
        if (!newTabId) return;
        const cacheKey = `task:${projectId}:${task.id}|${newTabId}`;
        void pasteToTerminal(cacheKey, detail.command);
      } else {
        // Flex layout: add a fresh terminal panel; paste via task prefix —
        // the newest-mounted terminal becomes "active" and wins the match.
        layoutRef.current?.addPanel("terminal");
        const prefix = `task:${projectId}:${task.id}|`;
        void pasteToTerminal(prefix, detail.command);
      }
    };
    window.addEventListener("grove:terminal-inject", handler);
    return () => window.removeEventListener("grove:terminal-inject", handler);
  }, [layoutMode, projectId, task.id]);

  useImperativeHandle(ref, () => ({
    addPanel: handleAddPanel,
    ensurePanel: handleEnsurePanel,
    selectTabByIndex: (index: number) => {
      if (layoutMode === "ide") {
        return ideLayoutRef.current?.selectTabByIndex(index) ?? "no_tabs";
      }
      return layoutRef.current?.selectTabByIndex(index) ?? "no_tabs";
    },
    selectAdjacentTab: (delta: number) => {
      if (layoutMode === "ide") {
        return ideLayoutRef.current?.selectAdjacentTab(delta) ?? false;
      }
      return layoutRef.current?.selectAdjacentTab(delta) ?? false;
    },
    closeActiveTab: () => {
      if (layoutMode === "ide") {
        ideLayoutRef.current?.closeActiveTab();
      } else {
        layoutRef.current?.closeActiveTab();
      }
    },
    sendTerminalInput: handleSendTerminalInput,
  }), [handleAddPanel, handleEnsurePanel, handleSendTerminalInput, layoutMode]);

  // Overflow menu items
  const isArchived = task.status === "archived";
  const isLocal = task.isLocal === true;
  const canOperate = !isArchived && !isLocal;

  // Panel + git op shortcuts — registered once per active TaskView so every
  // page that hosts one (TasksPage, BlitzPage, WorkPage) gets consistent
  // behavior. Previously each page registered its own copy with subtly
  // different `enabled` conditions, which is how WorkPage ended up with no
  // shortcuts at all. Gated by `!isArchived` since opening panels on an
  // archived task still makes sense, but git ops don't.
  const panelShortcutsEnabled = !isArchived;
  useHotkeys(
    [
      { key: "t", handler: () => handleAddPanel("terminal"), options: { enabled: panelShortcutsEnabled } },
      { key: "e", handler: () => handleAddPanel("editor"), options: { enabled: panelShortcutsEnabled } },
      { key: "r", handler: () => handleAddPanel("review"), options: { enabled: panelShortcutsEnabled } },
      { key: "g", handler: () => handleAddPanel("graph"), options: { enabled: panelShortcutsEnabled } },
      { key: "i", handler: () => handleAddPanel("chat"), options: { enabled: panelShortcutsEnabled } },
      // Git ops — only bound if the parent actually wired a handler (Studio
      // has no commit/merge/etc; Work may omit them on non-git projects).
      { key: "c", handler: () => onCommit?.(), options: { enabled: canOperate && !!onCommit } },
      { key: "s", handler: () => onSync?.(), options: { enabled: canOperate && !!onSync } },
      { key: "m", handler: () => onMerge?.(), options: { enabled: canOperate && !!onMerge } },
      { key: "b", handler: () => onRebase?.(), options: { enabled: canOperate && !!onRebase } },
    ],
    [
      panelShortcutsEnabled, canOperate, handleAddPanel,
      onCommit, onSync, onMerge, onRebase,
    ],
  );

  const overflowItems = useMemo<OverflowItem[]>(() => [
    ...(!isLocal && onRebase ? [{
      id: "rebase", label: "Rebase", icon: GitBranchPlus, onClick: onRebase,
      shortcut: "b", disabled: !canOperate,
    }] : []),
    ...(!isLocal && onArchive ? [{
      id: "archive", label: "Archive", icon: Archive, onClick: onArchive,
      variant: "warning" as const, disabled: isArchived, separator: true,
    }] : []),
    ...(onReset ? [{
      id: "reset", label: "Reset", icon: RotateCcw, onClick: onReset,
      variant: "warning" as const, disabled: isArchived,
      separator: isLocal,
    }] : []),
    ...(onClean ? [{
      id: "clean", label: "Clean", icon: Trash2, onClick: onClean,
      variant: "danger" as const,
    }] : []),
  ], [isLocal, onRebase, onArchive, onReset, onClean, canOperate, isArchived]);

  const workspaceLeading = useMemo(() => onBack ? (
    <div className="flex items-center gap-2.5 text-[12.5px] shrink-0">
      <button
        onClick={onBack}
        className="flex items-center gap-1 h-7 px-2 rounded-md text-[var(--color-text)]/50 hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors shrink-0"
        title="Back (Esc)"
      >
        <ArrowLeft size={13} />
        <span className="text-xs font-medium">Back</span>
      </button>
    </div>
  ) : undefined, [onBack]);

  const workspaceActions = useMemo(() => (
    <div className="flex items-center gap-1 shrink-0">
      {onCommit && (
        <button
          onClick={onCommit}
          disabled={isArchived}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
          title="Commit (c)"
        >
          <GitCommit size={13} />
          <span>Commit</span>
        </button>
      )}
      {onMerge && (
        <button
          onClick={onMerge}
          disabled={!canOperate}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
          title="Merge (m)"
        >
          <GitMerge size={13} />
          <span>Merge</span>
        </button>
      )}
      {!isLocal && onSync && (
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

      <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
      {overflowItems.length > 0 && <OverflowDropdown items={overflowItems} />}
    </div>
  ), [onCommit, onMerge, onSync, canOperate, isLocal, isArchived, overflowItems]);

  return (
    <div className={`flex-1 flex flex-col h-full overflow-hidden ${fullscreen ? 'fixed inset-0 z-50 bg-[var(--color-bg)]' : ''}`}>
      {/* Workspace Bar — hidden in fullscreen */}
      {!fullscreen && layoutMode !== "ide" && <div className="flex items-center h-9 px-3 gap-3 bg-[var(--color-bg)] border-b border-[var(--color-border)] shrink-0 select-none">
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

          {/* Branch info — accent color (hidden for Studio tasks with no branch) */}
          {task.branch && (
            <div className="flex items-center gap-1.5 text-[var(--color-accent)] shrink-0 opacity-75">
              <GitBranch size={13} />
              <span className="font-mono">{task.branch}</span>
              {!task.isLocal && task.target && (
                <>
                  <ArrowRight size={11} />
                  <span className="font-mono">{task.target}</span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Right: Git Actions + Overflow + CmdK + Fullscreen */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Git Actions — direct buttons (omitted on non-git projects) */}
          {onCommit && (
            <button
              onClick={onCommit}
              disabled={isArchived}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
              title="Commit (c)"
            >
              <GitCommit size={13} />
              <span>Commit</span>
            </button>
          )}
          {onMerge && (
            <button
              onClick={onMerge}
              disabled={!canOperate}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
              title="Merge (m)"
            >
              <GitMerge size={13} />
              <span>Merge</span>
            </button>
          )}
          {!isLocal && onSync && (
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

      {/* Layout area — fills remaining space */}
      <div className="flex-1 min-h-0 relative">
        {layoutMode === "ide" ? (
          <IDELayoutContainer
            ref={ideLayoutRef}
            task={task}
            projectId={projectId}
            toolbarLeading={workspaceLeading}
            toolbarTrailing={workspaceActions}
          />
        ) : (
          <FlexLayoutContainer
            ref={layoutRef}
            task={task}
            projectId={projectId}
            fullscreen={fullscreen}
            onToggleFullscreen={toggleFullscreen}
          />
        )}
      </div>
    </div>
  );
});

TaskView.displayName = "TaskView";
