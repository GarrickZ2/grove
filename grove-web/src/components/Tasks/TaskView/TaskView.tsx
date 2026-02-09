import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { TaskHeader } from "./TaskHeader";
import { TaskToolbar } from "./TaskToolbar";
import { TaskTerminal } from "./TaskTerminal";
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

  // Auto-sync header collapse with review/editor panel state
  useEffect(() => {
    setHeaderCollapsed(reviewOpen || editorOpen);
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

  // When terminal expands, close review/editor
  const handleExpandTerminal = () => {
    if (reviewOpen) onToggleReview();
    if (editorOpen) onToggleEditor();
  };

  // Fullscreen overlay rendered via portal to escape all parent containers
  const fullscreenOverlay = fullscreenPanel !== 'none' && createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]">
      {fullscreenPanel === 'terminal' && (
        <TaskTerminal
          projectId={projectId}
          task={task}
          collapsed={false}
          onExpand={handleExpandTerminal}
          onStartSession={onStartSession}
          autoStart={autoStartSession}
          onConnected={onTerminalConnected}
          fullscreen
          onToggleFullscreen={() => setFullscreenPanel('none')}
        />
      )}
      {fullscreenPanel === 'review' && reviewOpen && (
        <TaskCodeReview
          projectId={projectId}
          taskId={task.id}
          onClose={() => { setFullscreenPanel('none'); onToggleReview(); }}
          fullscreen
          onToggleFullscreen={() => setFullscreenPanel('none')}
        />
      )}
      {fullscreenPanel === 'editor' && editorOpen && (
        <TaskEditor
          projectId={projectId}
          taskId={task.id}
          onClose={() => { setFullscreenPanel('none'); onToggleEditor(); }}
          fullscreen
          onToggleFullscreen={() => setFullscreenPanel('none')}
        />
      )}
    </div>,
    document.body,
  );

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
      <div className="flex-1 flex gap-3 mt-3 min-h-0">
        {/* Terminal - collapses to vertical bar when review or editor is open */}
        <TaskTerminal
          projectId={projectId}
          task={task}
          collapsed={reviewOpen || editorOpen}
          onExpand={handleExpandTerminal}
          onStartSession={onStartSession}
          autoStart={autoStartSession}
          onConnected={onTerminalConnected}
          fullscreen={false}
          onToggleFullscreen={() => setFullscreenPanel('terminal')}
        />

        {/* Code Review Panel */}
        <AnimatePresence>
          {reviewOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "100%", opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <TaskCodeReview
                projectId={projectId}
                taskId={task.id}
                onClose={onToggleReview}
                fullscreen={false}
                onToggleFullscreen={() => setFullscreenPanel('review')}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Editor Panel */}
        <AnimatePresence>
          {editorOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "100%", opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <TaskEditor
                projectId={projectId}
                taskId={task.id}
                onClose={onToggleEditor}
                fullscreen={false}
                onToggleFullscreen={() => setFullscreenPanel('editor')}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Fullscreen overlay portal */}
      {fullscreenOverlay}
    </motion.div>
  );
}
