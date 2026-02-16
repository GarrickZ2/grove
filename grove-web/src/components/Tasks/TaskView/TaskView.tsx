import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TaskHeader } from "./TaskHeader";
import { TaskToolbar } from "./TaskToolbar";
import { TaskTerminal } from "./TaskTerminal";
import { TaskChat } from "./TaskChat";
import { TaskCodeReview } from "./TaskCodeReview";
import { TaskEditor } from "./TaskEditor";
import { FileSearchBar } from "../FileSearchBar";
import type { Task } from "../../../data/types";

interface TaskViewProps {
  /** Project ID for the task */
  projectId: string;
  task: Task;
  projectName?: string;
  reviewOpen: boolean;
  editorOpen: boolean;
  /** Auto-start terminal session on mount */
  autoStartSession?: boolean;
  /** Global multiplexer mode ("tmux" | "zellij" | "acp") */
  multiplexer?: string;
  onToggleReview: () => void;
  onToggleEditor: () => void;
  onCommit: () => void;
  onRebase: () => void;
  onSync: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onClean: () => void;
  onReset: () => void;
  onStartSession: () => void;
  /** Called when terminal connects (session becomes live) */
  onTerminalConnected?: () => void;
}

export function TaskView({
  projectId,
  task,
  projectName,
  reviewOpen,
  editorOpen,
  autoStartSession = false,
  multiplexer,
  onToggleReview,
  onToggleEditor,
  onCommit,
  onRebase,
  onSync,
  onMerge,
  onArchive,
  onClean,
  onReset,
  onStartSession,
  onTerminalConnected,
}: TaskViewProps) {
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [fullscreenPanel, setFullscreenPanel] = useState<'none' | 'terminal' | 'review' | 'editor'>('none');
  const [chatMinimized, setChatMinimized] = useState(false);
  const [chatWidthPercent, setChatWidthPercent] = useState(25);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Auto-sync header collapse with review/editor panel state
  useEffect(() => {
    setHeaderCollapsed(reviewOpen || editorOpen);
  }, [reviewOpen, editorOpen]);

  // Reset chatMinimized when all side panels close
  useEffect(() => {
    if (!reviewOpen && !editorOpen) setChatMinimized(false);
  }, [reviewOpen, editorOpen]);

  // Escape key exits fullscreen
  useEffect(() => {
    if (fullscreenPanel === 'none') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFullscreenPanel('none');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullscreenPanel]);

  // Drag-to-resize chat panel
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startPercent = chatWidthPercent;

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const containerWidth = containerRef.current.offsetWidth;
      const dx = startX - ev.clientX; // dragging left = increase chat width
      const newPercent = startPercent + (dx / containerWidth) * 100;
      setChatWidthPercent(Math.min(50, Math.max(15, newPercent)));
    };
    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [chatWidthPercent]);

  // Derived state for chat display mode
  const sidePanelOpen = reviewOpen || editorOpen;
  const chatVisible = sidePanelOpen && !chatMinimized && fullscreenPanel !== 'terminal';
  const chatCollapsed = sidePanelOpen && chatMinimized && fullscreenPanel !== 'terminal';


  return (
    <motion.div
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 200 }}
      className="flex-1 flex flex-col h-full overflow-hidden"
    >
      {/* Header */}
      <div className="rounded-t-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        {!headerCollapsed && <TaskHeader task={task} projectName={projectName} />}
        <TaskToolbar
          task={task}
          reviewOpen={reviewOpen}
          editorOpen={editorOpen}
          compact={headerCollapsed}
          taskName={task.name}
          taskStatus={task.status}
          projectName={projectName}
          headerCollapsed={headerCollapsed}
          onToggleHeaderCollapse={() => setHeaderCollapsed(!headerCollapsed)}
          onCommit={onCommit}
          onToggleReview={onToggleReview}
          onToggleEditor={onToggleEditor}
          onRebase={onRebase}
          onSync={onSync}
          onMerge={onMerge}
          onArchive={onArchive}
          onClean={onClean}
          onReset={onReset}
        />
        {!headerCollapsed && task.status !== "archived" && task.status !== "merged" && (
          <FileSearchBar projectId={projectId} taskId={task.id} />
        )}
      </div>

      {/* Main Content Area */}
      <div ref={containerRef} className="flex-1 flex gap-3 mt-3 min-h-0">
        {/* Terminal/Chat: fullscreen mode */}
        {fullscreenPanel === 'terminal' && (
          <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]">
            {multiplexer === "acp" ? (
              <TaskChat
                projectId={projectId}
                task={task}
                collapsed={false}
                onStartSession={onStartSession}
                autoStart={autoStartSession}
                onConnected={onTerminalConnected}
                fullscreen
                onToggleFullscreen={() => setFullscreenPanel('none')}
              />
            ) : (
              <TaskTerminal
                projectId={projectId}
                task={task}
                collapsed={false}
                onStartSession={onStartSession}
                autoStart={autoStartSession}
                onConnected={onTerminalConnected}
                fullscreen
                onToggleFullscreen={() => setFullscreenPanel('none')}
              />
            )}
          </div>
        )}

        {/* Collapsed bar on the LEFT (same position as original) */}
        {fullscreenPanel !== 'terminal' && chatCollapsed && (
          multiplexer === "acp" ? (
            <TaskChat
              projectId={projectId}
              task={task}
              collapsed
              onExpand={() => setChatMinimized(false)}
              onStartSession={onStartSession}
              autoStart={autoStartSession}
              onConnected={onTerminalConnected}
            />
          ) : (
            <TaskTerminal
              projectId={projectId}
              task={task}
              collapsed
              onExpand={() => setChatMinimized(false)}
              onStartSession={onStartSession}
              autoStart={autoStartSession}
              onConnected={onTerminalConnected}
            />
          )
        )}

        {/* Code Review Panel */}
        <AnimatePresence mode="popLayout">
          {reviewOpen && (
            <motion.div
              layout
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className={fullscreenPanel === 'review' ? 'fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]' : 'flex-1 flex flex-col overflow-hidden'}
            >
              <TaskCodeReview
                projectId={projectId}
                taskId={task.id}
                onClose={fullscreenPanel === 'review' ? () => { setFullscreenPanel('none'); onToggleReview(); } : onToggleReview}
                fullscreen={fullscreenPanel === 'review'}
                onToggleFullscreen={() => setFullscreenPanel(fullscreenPanel === 'review' ? 'none' : 'review')}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Editor Panel */}
        <AnimatePresence mode="popLayout">
          {editorOpen && (
            <motion.div
              layout
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className={fullscreenPanel === 'editor' ? 'fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]' : 'flex-1 flex flex-col overflow-hidden'}
            >
              <TaskEditor
                projectId={projectId}
                taskId={task.id}
                onClose={fullscreenPanel === 'editor' ? () => { setFullscreenPanel('none'); onToggleEditor(); } : onToggleEditor}
                fullscreen={fullscreenPanel === 'editor'}
                onToggleFullscreen={() => setFullscreenPanel(fullscreenPanel === 'editor' ? 'none' : 'editor')}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Resize handle + Chat on the RIGHT when side panel is open */}
        {fullscreenPanel !== 'terminal' && chatVisible && (
          <>
            {/* Drag handle */}
            <div
              onMouseDown={handleResizeStart}
              className="w-1 shrink-0 cursor-col-resize rounded-full hover:bg-[var(--color-highlight)] transition-colors bg-transparent self-stretch"
              title="Drag to resize"
            />
            <div className="shrink-0 flex flex-col min-h-0" style={{ width: `${chatWidthPercent}%` }}>
              {multiplexer === "acp" ? (
                <TaskChat
                  projectId={projectId}
                  task={task}
                  collapsed={false}
                  onCollapse={() => setChatMinimized(true)}
                  onStartSession={onStartSession}
                  autoStart={autoStartSession}
                  onConnected={onTerminalConnected}
                  onToggleFullscreen={() => setFullscreenPanel('terminal')}
                />
              ) : (
                <TaskTerminal
                  projectId={projectId}
                  task={task}
                  collapsed={false}
                  onStartSession={onStartSession}
                  autoStart={autoStartSession}
                  onConnected={onTerminalConnected}
                  onToggleFullscreen={() => setFullscreenPanel('terminal')}
                />
              )}
            </div>
          </>
        )}

        {/* Normal full-width layout (no side panel) */}
        {fullscreenPanel !== 'terminal' && !sidePanelOpen && (
          <div className="contents">
            {multiplexer === "acp" ? (
              <TaskChat
                projectId={projectId}
                task={task}
                collapsed={false}
                onStartSession={onStartSession}
                autoStart={autoStartSession}
                onConnected={onTerminalConnected}
                onToggleFullscreen={() => setFullscreenPanel('terminal')}
              />
            ) : (
              <TaskTerminal
                projectId={projectId}
                task={task}
                collapsed={false}
                onStartSession={onStartSession}
                autoStart={autoStartSession}
                onConnected={onTerminalConnected}
                onToggleFullscreen={() => setFullscreenPanel('terminal')}
              />
            )}
          </div>
        )}
      </div>

    </motion.div>
  );
}
