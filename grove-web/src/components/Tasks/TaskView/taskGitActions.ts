import { createContext, useContext } from "react";

/**
 * The task workspace's own Commit / Merge actions (the same callbacks its
 * toolbar buttons call, which open the existing dialogs), so panels deep in
 * the workspace — Code Review's merge footer — can start those flows without
 * new git logic. Null outside a TaskView (e.g. the standalone /review page).
 */
export interface TaskGitActions {
  onCommit?: () => void;
  onMerge?: () => void;
  commitDisabled: boolean;
  mergeDisabled: boolean;
}

export const TaskGitActionsContext = createContext<TaskGitActions | null>(null);

export function useTaskGitActions(): TaskGitActions | null {
  return useContext(TaskGitActionsContext);
}
