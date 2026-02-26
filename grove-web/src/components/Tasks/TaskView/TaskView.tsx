import { useState, useRef, forwardRef, useImperativeHandle } from "react";
import { TaskHeader } from "./TaskHeader";
import { TaskToolbar } from "./TaskToolbar";
import { FileSearchBar } from "../FileSearchBar";
import { FlexLayoutContainer, type FlexLayoutContainerHandle } from "../PanelSystem";
import type { Task } from "../../../data/types";
import type { PanelType } from "../PanelSystem/types";

interface TaskViewProps {
  /** Project ID for the task */
  projectId: string;
  task: Task;
  projectName?: string;
  /** Header collapsed state */
  headerCollapsed?: boolean;
  /** Callback when header collapsed state changes */
  onHeaderCollapsedChange?: (collapsed: boolean) => void;
  /** Fullscreen state (external control) */
  fullscreen?: boolean;
  /** Callback when fullscreen state changes */
  onFullscreenChange?: (fullscreen: boolean) => void;
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
}

export const TaskView = forwardRef<TaskViewHandle, TaskViewProps>((props, ref) => {
  const {
    projectId,
    task,
    projectName,
    headerCollapsed: externalHeaderCollapsed = true,
    onHeaderCollapsedChange,
    fullscreen: externalFullscreen,
    onFullscreenChange,
    onCommit,
    onRebase,
    onSync,
    onMerge,
    onArchive,
    onClean,
    onReset,
  } = props;
  const [internalHeaderCollapsed, setInternalHeaderCollapsed] = useState(true);
  const [internalFullscreen, setInternalFullscreen] = useState(false);
  const layoutRef = useRef<FlexLayoutContainerHandle>(null);

  // Use external state if provided, otherwise use internal state
  const headerCollapsed = onHeaderCollapsedChange ? externalHeaderCollapsed : internalHeaderCollapsed;
  const setHeaderCollapsed = onHeaderCollapsedChange || setInternalHeaderCollapsed;

  const fullscreen = externalFullscreen !== undefined ? externalFullscreen : internalFullscreen;
  const setFullscreen = onFullscreenChange
    ? (value: boolean) => onFullscreenChange(value)
    : setInternalFullscreen;

  // Per-task multiplexer (from task metadata)
  const multiplexer = task.multiplexer || "tmux"; // 保留向后兼容

  // Handle adding panels through ref
  const handleAddPanel = (type: PanelType) => {
    setHeaderCollapsed(true); // Auto-collapse header when adding panels
    if (layoutRef.current) {
      layoutRef.current.addPanel(type);
    }
    // 注意: 不调用 onAddPanel(type) 避免无限循环
    // onAddPanel 仅用于外部通知,这里已经完成添加工作
  };

  // Expose addPanel method via ref
  useImperativeHandle(ref, () => ({
    addPanel: handleAddPanel,
  }), [handleAddPanel]);

  // Toggle fullscreen
  const toggleFullscreen = () => {
    const newValue = !fullscreen;
    setFullscreen(newValue);
  };

  return (
    <div
      className={`flex-1 flex flex-col h-full overflow-hidden rounded-l-lg ${
        fullscreen ? 'fixed inset-0 z-50 rounded-none' : ''
      }`}
    >
      {/* Header - hidden in fullscreen */}
      {!fullscreen && (
        <div className="rounded-t-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
          {!headerCollapsed && <TaskHeader task={task} projectName={projectName} />}
          <TaskToolbar
            task={task}
            headerCollapsed={headerCollapsed}
            onToggleHeaderCollapse={() => setHeaderCollapsed(!headerCollapsed)}
            onAddTerminal={() => handleAddPanel('terminal')}
            onAddChat={() => handleAddPanel('chat')}
            onAddReview={() => handleAddPanel('review')}
            onAddEditor={() => handleAddPanel('editor')}
            onCommit={onCommit}
            onRebase={onRebase}
            onSync={onSync}
            onMerge={onMerge}
            onArchive={onArchive}
            onClean={onClean}
            onReset={onReset}
          />
          {!headerCollapsed && task.status !== "archived" && task.status !== "merged" && multiplexer !== "acp" && (
            <FileSearchBar projectId={projectId} taskId={task.id} />
          )}
        </div>
      )}

      {/* FlexLayout Container */}
      <div className={`flex-1 min-h-0 relative ${fullscreen ? '' : 'mt-3'}`}>
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

TaskView.displayName = 'TaskView';
