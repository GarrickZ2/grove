import { useState, useCallback, useEffect, useRef } from "react";
import {
  listTaskGroups,
  createTaskGroup,
  updateTaskGroup,
  deleteTaskGroup,
  upsertTaskSlot,
  removeTaskSlot,
  setSlots,
} from "../api";
import type { TaskGroup, TaskSlot } from "../data/types";
import { MAIN_GROUP_ID, LOCAL_GROUP_ID } from "../data/types";

/** Sort order: _main first, custom groups in the middle, _local last. */
function sortGroups(groups: TaskGroup[]): TaskGroup[] {
  return [...groups].sort((a, b) => {
    const rank = (g: TaskGroup) => {
      if (g.id === MAIN_GROUP_ID) return 0;
      if (g.id === LOCAL_GROUP_ID) return 2;
      return 1;
    };
    return rank(a) - rank(b);
  });
}

export interface UseTaskGroupsResult {
  groups: TaskGroup[];
  isLoading: boolean;
  createGroup: (name: string, color?: string) => Promise<void>;
  updateGroup: (id: string, data: { name?: string; color?: string | null }) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  assignTask: (
    groupId: string,
    position: number,
    projectId: string,
    taskId: string,
  ) => Promise<void>;
  removeTask: (groupId: string, position: number) => Promise<void>;
  setSlots: (groupId: string, slots: TaskSlot[]) => void;
  moveTask: (
    fromGroupId: string,
    toGroupId: string,
    projectId: string,
    taskId: string,
  ) => void;
  refresh: () => Promise<void>;
}

export function useTaskGroups(): UseTaskGroupsResult {
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const refresh = useCallback(async () => {
    try {
      const { groups: fetched } = await listTaskGroups();
      setGroups(sortGroups(fetched));
    } catch (err) {
      console.error("[TaskGroups] refresh failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreateGroup = useCallback(
    async (name: string, color?: string) => {
      try {
        await createTaskGroup(name, color);
        await refresh();
      } catch (err) {
        console.error("[TaskGroups] createGroup failed:", err);
      }
    },
    [refresh],
  );

  const handleUpdateGroup = useCallback(
    async (id: string, data: { name?: string; color?: string | null }) => {
      try {
        await updateTaskGroup(id, data);
        await refresh();
      } catch (err) {
        console.error("[TaskGroups] updateGroup failed:", err);
      }
    },
    [refresh],
  );

  const handleDeleteGroup = useCallback(
    async (id: string) => {
      try {
        await deleteTaskGroup(id);
        // Refresh to get updated _main/_local with moved-back tasks
        await refresh();
      } catch (err) {
        console.error("[TaskGroups] deleteGroup failed:", err);
      }
    },
    [refresh],
  );

  const handleAssignTask = useCallback(
    async (
      groupId: string,
      position: number,
      projectId: string,
      taskId: string,
    ) => {
      // Optimistically update local state
      const newSlot: TaskSlot = {
        position,
        project_id: projectId,
        task_id: taskId,
      };
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== groupId) return g;
          // Replace existing slot at same position, or append
          const filtered = g.slots.filter((s) => s.position !== position);
          return { ...g, slots: [...filtered, newSlot] };
        }),
      );

      // Fire-and-forget API call — refresh on failure to revert optimistic update
      upsertTaskSlot(groupId, {
        position,
        project_id: projectId,
        task_id: taskId,
      }).catch((err) => {
        console.error("[TaskGroups] assignTask failed:", err);
        refresh();
      });
    },
    [refresh],
  );

  const handleRemoveTask = useCallback(
    async (groupId: string, position: number) => {
      // Optimistically update local state
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== groupId) return g;
          return { ...g, slots: g.slots.filter((s) => s.position !== position) };
        }),
      );

      // Fire-and-forget API call — refresh on failure to revert optimistic update
      removeTaskSlot(groupId, position).catch((err) => {
        console.error("[TaskGroups] removeTask failed:", err);
        refresh();
      });
    },
    [refresh],
  );

  const handleSetSlots = useCallback(
    (groupId: string, newSlots: TaskSlot[]) => {
      // Optimistically update local state
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== groupId) return g;
          return { ...g, slots: newSlots };
        }),
      );

      // Fire-and-forget API call — refresh on failure to revert optimistic update
      setSlots(groupId, newSlots).catch((err) => {
        console.error("[TaskGroups] setSlots failed:", err);
        refresh();
      });
    },
    [refresh],
  );

  const handleMoveTask = useCallback(
    (
      fromGroupId: string,
      toGroupId: string,
      projectId: string,
      taskId: string,
    ) => {
      // Use ref to read latest groups (avoids stale closure in rapid operations)
      const latestGroups = groupsRef.current;
      const sourceGroup = latestGroups.find((g) => g.id === fromGroupId);
      const slot = sourceGroup?.slots.find(
        (s) => s.project_id === projectId && s.task_id === taskId,
      );
      if (!slot) return;

      const targetGroup = latestGroups.find((g) => g.id === toGroupId);
      const existingPositions = targetGroup
        ? targetGroup.slots.map((s) => s.position)
        : [];
      let nextPos = 1;
      while (existingPositions.includes(nextPos)) nextPos++;

      const movedSlot: TaskSlot = { ...slot, position: nextPos };

      // Optimistic update
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id === fromGroupId) {
            return {
              ...g,
              slots: g.slots.filter(
                (s) => !(s.project_id === projectId && s.task_id === taskId),
              ),
            };
          }
          if (g.id === toGroupId) {
            return { ...g, slots: [...g.slots, movedSlot] };
          }
          return g;
        }),
      );

      // Chain API calls sequentially to avoid TOCTOU race on the same TOML file
      removeTaskSlot(fromGroupId, slot.position)
        .then(() => upsertTaskSlot(toGroupId, {
          position: nextPos,
          project_id: projectId,
          task_id: taskId,
        }))
        .catch((err) => {
          console.error("[TaskGroups] moveTask failed:", err);
          refresh();
        });
    },
    [refresh],
  );

  return {
    groups,
    isLoading,
    createGroup: handleCreateGroup,
    updateGroup: handleUpdateGroup,
    deleteGroup: handleDeleteGroup,
    assignTask: handleAssignTask,
    removeTask: handleRemoveTask,
    setSlots: handleSetSlots,
    moveTask: handleMoveTask,
    refresh,
  };
}
