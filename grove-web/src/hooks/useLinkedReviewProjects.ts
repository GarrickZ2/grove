import { useEffect, useState } from "react";
import { getLinkedProjects, type LinkedProjectItem } from "../api";

/** Fired after a Task's linked Project set is saved, so every surface showing
 *  linked reviews (Review panel tabs, panel availability) refreshes at once. */
export const LINKED_PROJECTS_CHANGED_EVENT = "grove:linked-projects-changed";

export interface LinkedProjectsChangedDetail {
  projectId: string;
  taskId: string;
  linkedProjects: LinkedProjectItem[];
}

/** A linked Project whose Code Review can be shown in this Task's Review panel. */
export interface LinkedReviewProject {
  projectId: string;
  taskId: string;
  name: string;
  isGitRepo: boolean;
}

function toReviewProjects(items: LinkedProjectItem[]): LinkedReviewProject[] {
  return items.flatMap((item) =>
    item.exists && item.review_task_id
      ? [{ projectId: item.id, taskId: item.review_task_id, name: item.name, isGitRepo: item.is_git_repo }]
      : [],
  );
}

/** Linked Projects of a Task that have a reviewable Local Task, in link order. */
export function useLinkedReviewProjects(projectId: string, taskId: string): LinkedReviewProject[] {
  const [state, setState] = useState<{ key: string; projects: LinkedReviewProject[] }>({
    key: "",
    projects: [],
  });
  const key = `${projectId}:${taskId}`;

  useEffect(() => {
    let cancelled = false;
    getLinkedProjects(projectId, taskId)
      .then((res) => {
        if (!cancelled) setState({ key, projects: toReviewProjects(res.linked_projects) });
      })
      .catch(() => {
        if (!cancelled) setState({ key, projects: [] });
      });
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<LinkedProjectsChangedDetail>).detail;
      if (!detail || detail.projectId !== projectId || detail.taskId !== taskId) return;
      setState({ key, projects: toReviewProjects(detail.linkedProjects) });
    };
    window.addEventListener(LINKED_PROJECTS_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(LINKED_PROJECTS_CHANGED_EVENT, onChanged);
    };
  }, [projectId, taskId, key]);

  // Never leak the previous task's links while the new fetch is in flight.
  return state.key === key ? state.projects : EMPTY;
}

const EMPTY: LinkedReviewProject[] = [];
