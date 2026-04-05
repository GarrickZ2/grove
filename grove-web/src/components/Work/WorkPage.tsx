import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TaskView, type TaskViewHandle } from "../Tasks/TaskView";
import { TaskOperationDialogs } from "../Tasks/TaskOperationDialogs";
import { useProject, useCommandPalette } from "../../context";
import { useTaskOperations, usePostMergeArchive, buildCommands } from "../../hooks";
import type { PanelType } from "../Tasks/PanelSystem/types";
import type { PendingArchiveConfirm } from "../../utils/archiveHelpers";
import { resolveLocalTask } from "../../utils/localTask";

/**
 * Work — dedicated page for a project's Local Task (the always-present
 * "work in the main repo" session).
 *
 * Renders TaskView directly; no task list, no filters, no inWorkspace state.
 * Local Task is resolved synchronously (backend version preferred, else
 * synthesized from project metadata), so the page mounts straight into the
 * workspace with zero flash or loading intermediate.
 */
export function WorkPage() {
  const { selectedProject, refreshSelectedProject } = useProject();

  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pendingArchiveConfirm, setPendingArchiveConfirm] = useState<PendingArchiveConfirm | null>(null);
  const taskViewRef = useRef<TaskViewHandle>(null);

  const showMessage = (msg: string) => {
    setOperationMessage(msg);
    setTimeout(() => setOperationMessage(null), 3000);
  };

  const [postMergeState, postMergeHandlers] = usePostMergeArchive({
    projectId: selectedProject?.id ?? null,
    onRefresh: refreshSelectedProject,
    onShowMessage: showMessage,
    onCleanup: () => {},
    setPendingArchiveConfirm,
  });

  const localTask = selectedProject ? resolveLocalTask(selectedProject) : null;

  const [opsState, opsHandlers] = useTaskOperations({
    projectId: selectedProject?.id ?? null,
    selectedTask: localTask,
    onRefresh: refreshSelectedProject,
    onShowMessage: showMessage,
    onTaskArchived: () => {
      // Local Task cannot be archived; nothing to clean up.
    },
    onTaskMerged: (taskId, taskName) => {
      postMergeHandlers.triggerPostMergeArchive(taskId, taskName);
    },
    setPendingArchiveConfirm,
  });

  // Register page-level commands (Cmd+K) so Work mode exposes the same panel
  // actions (Terminal / Chat / Review / Editor / Stats / Git / Notes / Comments)
  // and task operations as the Tasks workspace.
  const { registerPageCommands, unregisterPageCommands, setInWorkspace: setContextInWorkspace, setPageContext } =
    useCommandPalette();

  useEffect(() => {
    // Work is always in workspace mode
    setContextInWorkspace(true);
    setPageContext("workspace");
    return () => {
      setContextInWorkspace(false);
      setPageContext("default");
    };
  }, [setContextInWorkspace, setPageContext]);

  const handleAddPanel = (type: PanelType) => {
    taskViewRef.current?.addPanel(type);
  };

  const pageOptionsRef = useRef<Parameters<typeof buildCommands>[0]>(null!);

  // Keep the ref in sync with the latest handlers/state. buildCommands() is
  // called on-demand via the registered factory and reads ref.current, so the
  // palette always sees fresh values.
  useEffect(() => {
    pageOptionsRef.current = {
      taskActions: localTask
        ? {
            selectedTask: localTask,
            inWorkspace: true,
            opsHandlers,
            onEnterWorkspace: () => {
              // Already in workspace; no-op
            },
            onOpenPanel: (panel) => handleAddPanel(panel as PanelType),
            onSwitchInfoTab: () => {
              // Work has no info panel side — tab switch opens as panel instead
            },
            onRefresh: refreshSelectedProject,
          }
        : undefined,
    };
  });

  useEffect(() => {
    registerPageCommands(() => buildCommands(pageOptionsRef.current));
    return () => unregisterPageCommands();
  }, [registerPageCommands, unregisterPageCommands]);

  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--color-text-muted)]">Select a project to start working</p>
      </div>
    );
  }

  if (!localTask) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--color-text-muted)]">Loading work session…</p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-full flex flex-col"
    >
      <div className="flex-1 relative overflow-hidden">
        <TaskView
          ref={taskViewRef}
          projectId={selectedProject.id}
          task={localTask}
          projectName={selectedProject.name}
          fullscreen={isFullscreen}
          onFullscreenChange={setIsFullscreen}
          // onBack intentionally omitted — Work has no list to go back to
          // Git-dependent actions are disabled on non-git projects. Review
          // is intentionally kept: its "All Files" mode is still useful
          // without git history.
          onCommit={selectedProject.isGitRepo ? opsHandlers.handleCommit : undefined}
          onRebase={selectedProject.isGitRepo ? opsHandlers.handleRebase : undefined}
          onSync={selectedProject.isGitRepo ? opsHandlers.handleSync : undefined}
          onMerge={selectedProject.isGitRepo ? opsHandlers.handleMerge : undefined}
          onArchive={selectedProject.isGitRepo ? opsHandlers.handleArchive : undefined}
          onClean={selectedProject.isGitRepo ? opsHandlers.handleClean : undefined}
          onReset={selectedProject.isGitRepo ? opsHandlers.handleReset : undefined}
        />
      </div>

      {/* Operation Message Toast */}
      <AnimatePresence>
        {operationMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-lg"
          >
            <span className="text-sm text-[var(--color-text)]">{operationMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <TaskOperationDialogs
        task={localTask}
        opsState={opsState}
        opsHandlers={opsHandlers}
        postMergeState={postMergeState}
        postMergeHandlers={postMergeHandlers}
        pendingArchiveConfirm={pendingArchiveConfirm}
      />
    </motion.div>
  );
}
