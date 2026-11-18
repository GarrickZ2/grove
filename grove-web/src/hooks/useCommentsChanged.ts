import { useCallback, useEffect, useRef } from "react";
import { useRadioEvents } from "./useRadioEvents";

/**
 * Read a Task's review comments again whenever they change — anyone's
 * comment, reply, edit, resolve or delete, pushed by the server — and after
 * the event connection comes back, for what was missed while it was down.
 */
export function useCommentsChanged(
  projectId: string | null | undefined,
  taskId: string | null | undefined,
  reload: () => void,
): void {
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useRadioEvents({
    onCommentsChanged: useCallback((changedProject: string, changedTask: string) => {
      if (changedProject === projectId && changedTask === taskId) reloadRef.current();
    }, [projectId, taskId]),
    onConnected: useCallback(() => {
      if (projectId && taskId) reloadRef.current();
    }, [projectId, taskId]),
  });
}
