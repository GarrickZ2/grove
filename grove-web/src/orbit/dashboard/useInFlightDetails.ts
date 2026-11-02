import { useCallback, useEffect, useRef, useState } from "react";
import { getDiff, getLinkedProjects, updateLinkedProjects, type LinkedProjectItem } from "../../api";
import { useRadioEvents } from "../../hooks/useRadioEvents";
import { LINKED_PROJECTS_CHANGED_EVENT, type LinkedProjectsChangedDetail } from "../../hooks/useLinkedReviewProjects";

export interface TaskDiff {
  additions: number;
  deletions: number;
}

/** Concurrent per-task requests (each `getDiff` runs git in the worktree). */
const PARALLEL = 4;
/** A finished turn usually changed files; refetch its diff after it settles. */
const DIFF_REFRESH_DELAY_MS = 600;

async function eachLimited<T>(items: T[], run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

/**
 * Per-task facts for the In flight list: the worktree diff against its
 * target (refreshed when one of its sessions finishes a turn) and the
 * task's linked projects, which can be edited in place.
 */
export function useInFlightDetails(projectId: string | undefined, taskIds: string[]) {
  const [diffs, setDiffs] = useState<Record<string, TaskDiff>>({});
  const [links, setLinks] = useState<Record<string, LinkedProjectItem[]>>({});
  const [savingTask, setSavingTask] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const timers = useRef<Record<string, number>>({});
  const idsKey = taskIds.join("\u0000");

  const loadDiff = useCallback(async (pid: string, taskId: string) => {
    try {
      const diff = await getDiff(pid, taskId);
      setDiffs((previous) => ({ ...previous, [`${pid}:${taskId}`]: { additions: diff.total_additions, deletions: diff.total_deletions } }));
    } catch {
      // A broken worktree simply shows no diff.
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const ids = idsKey ? idsKey.split("\u0000") : [];
    void eachLimited(ids, async (taskId) => {
      if (cancelled) return;
      await Promise.all([
        loadDiff(projectId, taskId),
        getLinkedProjects(projectId, taskId)
          .then((res) => { if (!cancelled) setLinks((previous) => ({ ...previous, [`${projectId}:${taskId}`]: res.linked_projects })); })
          .catch(() => undefined),
      ]);
    });
    return () => { cancelled = true; };
  }, [projectId, idsKey, loadDiff]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<LinkedProjectsChangedDetail>).detail;
      if (detail?.projectId === projectId) setLinks((previous) => ({ ...previous, [`${detail.projectId}:${detail.taskId}`]: detail.linkedProjects }));
    };
    window.addEventListener(LINKED_PROJECTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LINKED_PROJECTS_CHANGED_EVENT, onChanged);
  }, [projectId]);

  useEffect(() => {
    const pending = timers.current;
    return () => { for (const timer of Object.values(pending)) window.clearTimeout(timer); };
  }, []);

  useRadioEvents({
    onChatStatus: (pid, taskId, _chatId, status) => {
      if (pid !== projectId || status !== "idle" || !idsKey.split("\u0000").includes(taskId)) return;
      window.clearTimeout(timers.current[taskId]);
      timers.current[taskId] = window.setTimeout(() => void loadDiff(pid, taskId), DIFF_REFRESH_DELAY_MS);
    },
  });

  const saveLinks = useCallback(async (taskId: string, projectIds: string[]) => {
    if (!projectId || savingTask) return;
    setSavingTask(taskId);
    setLinkError(null);
    try {
      const result = await updateLinkedProjects(projectId, taskId, projectIds);
      setLinks((previous) => ({ ...previous, [`${projectId}:${taskId}`]: result.linked_projects }));
      window.dispatchEvent(new CustomEvent<LinkedProjectsChangedDetail>(LINKED_PROJECTS_CHANGED_EVENT, {
        detail: { projectId, taskId, linkedProjects: result.linked_projects },
      }));
    } catch {
      setLinkError("Couldn’t update linked projects. Try again.");
    } finally {
      setSavingTask(null);
    }
  }, [projectId, savingTask]);

  // Keyed by project too: task ids are only unique within a project.
  const diffFor = (taskId: string): TaskDiff | undefined => diffs[`${projectId}:${taskId}`];
  const linksFor = (taskId: string): LinkedProjectItem[] | undefined => links[`${projectId}:${taskId}`];
  return { diffFor, linksFor, saveLinks, savingTask, linkError };
}
