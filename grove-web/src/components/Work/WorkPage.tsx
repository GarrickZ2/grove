import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TaskView, type TaskViewHandle } from "../Tasks/TaskView";
import { TaskOperationDialogs } from "../Tasks/TaskOperationDialogs";
import { useProject, useCommandPalette } from "../../context";
import { useTaskOperations, usePostMergeArchive, buildCommands, useChatDeepLink } from "../../hooks";
import type { PanelType } from "../Tasks/PanelSystem/types";
import type { PendingArchiveConfirm } from "../../utils/archiveHelpers";
import { resolveLocalTask } from "../../utils/localTask";

interface WorkPageProps {
  /** Deep-link to a specific chat session under the Local Task — e.g. from
   *  a notification, tray, or the Dynamic Island live-activity alert.
   *  TasksPage/BlitzPage have had this for worktree tasks for a while;
   *  Work never did, so clicking a Local Task notification silently did
   *  nothing beyond landing on the page. */
  initialChatId?: string;
  /** Called once `initialChatId` has been consumed, so the caller can
   *  clear navigationData and this effect doesn't refire. */
  onNavigationConsumed?: () => void;
  /** Whether the page is the currently visible surface. WorkPage joins
   *  TasksPage in the keep-alive club: App keeps it mounted (display:none)
   *  once visited, so Work ⇄ Tasks switches don't unmount/remount a whole
   *  TaskChat stack in one commit (that teardown + hidden→shown reflow was
   *  the multi-second gap entering a task from Work). While hidden, the
   *  keyboard scope, context keys and page commands must drop — same
   *  contract as TasksPage's `pageVisible`. Defaults to true for
   *  backwards compatibility. */
  pageVisible?: boolean;
}

/**
 * Work — dedicated page for a project's built-in Local Task. Coding uses
 * the main repository; Studio uses its own task workspace.
 *
 * Renders TaskView directly; no task list, no filters, no inWorkspace state.
 * Coding can synthesize a fallback from project metadata; Studio waits for
 * the backend to initialize its task directory and return the real task.
 *
 * Lifecycle: keep-alive, mirroring TasksPage. App mounts it on first visit
 * and then only flips `display` — the Local Task workspace survives nav
 * switches, and `pageVisible=false` is the signal to drop keyboard scope,
 * context keys and page commands while hidden.
 */
export function WorkPage({ initialChatId, onNavigationConsumed, pageVisible = true }: WorkPageProps) {
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

  const localTask = selectedProject ? (selectedProject.projectType === "studio" ? selectedProject.localTask : resolveLocalTask(selectedProject)) : null;

  // Switch to a specific chat session if a deep-link asked for one.
  useChatDeepLink({
    chatId: initialChatId,
    projectId: selectedProject?.id,
    taskId: localTask?.id,
    onConsumed: onNavigationConsumed,
  });

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
    // Work is always in workspace mode — but only own the shared context while
    // visible. Both pages stay mounted now, so writing while hidden would
    // clobber the surface the user is actually looking at.
    if (!pageVisible) return;
    setContextInWorkspace(true);
    setPageContext("workspace");
    return () => {
      setContextInWorkspace(false);
      setPageContext("default");
    };
  }, [pageVisible, setContextInWorkspace, setPageContext]);

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
            isStudio: selectedProject?.projectType === "studio",
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
    // registerPageCommands is a single shared slot — gate on visibility and
    // re-take the slot every time the page becomes visible (TasksPage does
    // the same now that both pages are keep-alive).
    if (!pageVisible) return;
    registerPageCommands(() => buildCommands(pageOptionsRef.current));
    return () => unregisterPageCommands();
  }, [pageVisible, registerPageCommands, unregisterPageCommands]);

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
          isActive={pageVisible}
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
