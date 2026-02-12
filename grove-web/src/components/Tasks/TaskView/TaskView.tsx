import { useState, useEffect } from "react";
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
        <div className={fullscreenPanel === 'terminal' ? 'fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]' : 'contents'}>
          <TaskTerminal
            projectId={projectId}
            task={task}
            collapsed={fullscreenPanel === 'terminal' ? false : (reviewOpen || editorOpen)}
            onExpand={handleExpandTerminal}
            onStartSession={onStartSession}
            autoStart={autoStartSession}
            onConnected={onTerminalConnected}
            fullscreen={fullscreenPanel === 'terminal'}
            onToggleFullscreen={() => setFullscreenPanel(fullscreenPanel === 'terminal' ? 'none' : 'terminal')}
          />
        </div>

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
      </div>

    </motion.div>
  );
}
