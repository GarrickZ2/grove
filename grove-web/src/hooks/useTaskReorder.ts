import { useCallback, useMemo, useRef, useState } from "react";
import { reorderTasks } from "../api";

export type DropPlacement = "before" | "after";

/** Move `movedId` next to `anchorId`; returns `ids` unchanged when either is missing. */
export function moveTaskId(ids: string[], movedId: string, anchorId: string, placement: DropPlacement): string[] {
  if (movedId === anchorId || !ids.includes(movedId) || !ids.includes(anchorId)) return ids;
  const rest = ids.filter((id) => id !== movedId);
  const anchorIndex = rest.indexOf(anchorId);
  rest.splice(placement === "after" ? anchorIndex + 1 : anchorIndex, 0, movedId);
  return rest;
}

/** Apply a saved id order to `tasks`. Tasks missing from `ids` (created meanwhile) go first, like new tasks. */
export function applyTaskOrder<T extends { id: string }>(tasks: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  const unranked = tasks.filter((task) => !rank.has(task.id));
  const ranked = tasks.filter((task) => rank.has(task.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...unranked, ...ranked];
}

/** Top half of the hovered row drops before it, bottom half after. */
export function dropPlacementFor(event: React.DragEvent<HTMLElement>): DropPlacement {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export interface TaskDropTarget {
  taskId: string;
  placement: DropPlacement;
}

/**
 * Manual ordering for a project's active tasks, shared by the Orbit and
 * Workbench sidebars. A move shows immediately; requests are serialized so the
 * last move wins, and the optimistic order holds until the project refresh
 * that follows the final pending request lands.
 */
export function useTaskReorder<T extends { id: string }>(
  projectId: string | undefined,
  tasks: T[],
  refreshProject: () => Promise<void>,
  onError?: (message: string) => void,
) {
  const [pending, setPending] = useState<{ projectId: string; ids: string[] } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskDropTarget | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0);

  const orderedTasks = useMemo(
    () => (pending && pending.projectId === projectId ? applyTaskOrder(tasks, pending.ids) : tasks),
    [pending, projectId, tasks],
  );

  const commit = useCallback((ids: string[]) => {
    if (!projectId) return;
    const current = orderedTasks.map((task) => task.id);
    if (ids.every((id, index) => id === current[index])) return;
    const token = ++generation.current;
    setPending({ projectId, ids });
    queue.current = queue.current.then(async () => {
      try {
        await reorderTasks(projectId, ids);
        if (token === generation.current) await refreshProject();
      } catch (err) {
        console.error("Failed to reorder tasks", err);
        onError?.("Could not save the task order.");
        if (token === generation.current) await refreshProject().catch(() => undefined);
      } finally {
        if (token === generation.current) setPending(null);
      }
    });
  }, [projectId, orderedTasks, refreshProject, onError]);

  const moveTask = useCallback((movedId: string, anchorId: string, placement: DropPlacement) => {
    commit(moveTaskId(orderedTasks.map((task) => task.id), movedId, anchorId, placement));
  }, [commit, orderedTasks]);

  const moveBy = useCallback((taskId: string, delta: -1 | 1) => {
    const ids = orderedTasks.map((task) => task.id);
    const anchor = ids[ids.indexOf(taskId) + delta];
    if (anchor) moveTask(taskId, anchor, delta < 0 ? "before" : "after");
  }, [moveTask, orderedTasks]);

  const endDrag = useCallback(() => { setDraggingId(null); setDropTarget(null); }, []);

  /** Props for the element the user grabs. `enabled` false leaves it inert. */
  const dragSourceProps = useCallback((taskId: string, enabled: boolean) => enabled ? {
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", taskId);
      setDraggingId(taskId);
    },
    onDragEnd: endDrag,
  } : {}, [endDrag]);

  /** Props for the element a dragged task drops onto (may be larger than the source). */
  const dropTargetProps = useCallback((taskId: string) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!draggingId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const placement = dropPlacementFor(event);
      setDropTarget((previous) => (previous?.taskId === taskId && previous.placement === placement ? previous : { taskId, placement }));
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!draggingId) return;
      event.preventDefault();
      moveTask(draggingId, taskId, dropPlacementFor(event));
      endDrag();
    },
  }), [draggingId, moveTask, endDrag]);

  return { orderedTasks, moveBy, draggingId, dropTarget, dragSourceProps, dropTargetProps };
}
