import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TaskHeader } from "./TaskHeader";
import { TaskToolbar } from "./TaskToolbar";
import { TaskTerminal } from "./TaskTerminal";
import { TaskCodeReview } from "./TaskCodeReview";
import { FileSearchBar } from "../FileSearchBar";
import type { Task } from "../../../data/types";

interface TaskViewProps {
  /** Project ID for the task */
  projectId: string;
  task: Task;
  reviewOpen: boolean;
  /** Auto-start terminal session on mount */
  autoStartSession?: boolean;
  onToggleReview: () => void;
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
  reviewOpen,
  autoStartSession = false,
  onToggleReview,
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

  // Auto-sync header collapse with review panel state
  useEffect(() => {
    setHeaderCollapsed(reviewOpen);
  }, [reviewOpen]);

  // When terminal expands, close review
  const handleExpandTerminal = () => {
    if (reviewOpen) {
      onToggleReview();
    }
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
        {!headerCollapsed && <TaskHeader task={task} />}
        <TaskToolbar
          task={task}
          reviewOpen={reviewOpen}
          compact={headerCollapsed}
          taskName={task.name}
          taskStatus={task.status}
          headerCollapsed={headerCollapsed}
          onToggleHeaderCollapse={() => setHeaderCollapsed(!headerCollapsed)}
          onCommit={onCommit}
          onToggleReview={onToggleReview}
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
        {/* Terminal - collapses to vertical bar when review is open */}
        <TaskTerminal
          projectId={projectId}
          task={task}
          collapsed={reviewOpen}
          onExpand={handleExpandTerminal}
          onStartSession={onStartSession}
          autoStart={autoStartSession}
          onConnected={onTerminalConnected}
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
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
