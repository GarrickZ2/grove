import { useCallback, useEffect, useState } from "react";
import {
  getDiff,
  getCommits,
  getLinkedProjects,
  updateLinkedProjects,
  listProjects,
  type DiffResponse,
  type CommitsResponse,
  type LinkedProjectItem,
  type ProjectListItem,
} from "../../../../api";
import { getTaskStatistics, type PeriodData, type TimeseriesBucket } from "../../../../api/statistics";
import {
  LINKED_PROJECTS_CHANGED_EVENT,
  type LinkedProjectsChangedDetail,
} from "../../../../hooks/useLinkedReviewProjects";

/** Days of hourly usage fetched for the Usage chart. */
export const USAGE_DAYS = 14;

/**
 * Task Info data shared by the Workbench and Orbit renders: the branch diff,
 * its commits and the task's agent usage (all time, plus the last
 * `USAGE_DAYS` days hourly for the chart). All best-effort: Studio tasks have
 * no diff or commits, and a task nobody has chatted in has no usage.
 */
export function useTaskStats(projectId: string, taskId: string) {
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [commitsData, setCommitsData] = useState<CommitsResponse | null>(null);
  const [usage, setUsage] = useState<PeriodData | null>(null);
  const [recentUsage, setRecentUsage] = useState<TimeseriesBucket[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    const now = Math.floor(Date.now() / 1000);
    Promise.all([
      getDiff(projectId, taskId).catch(() => null),
      getCommits(projectId, taskId).catch(() => null),
      getTaskStatistics(projectId, taskId, { from: 0, to: now, bucket: "monthly" }).catch(() => null),
      getTaskStatistics(projectId, taskId, { from: now - USAGE_DAYS * 86_400, to: now, bucket: "hourly" }).catch(() => null),
    ])
      .then(([diffRes, commitsRes, allTime, recent]) => {
        if (cancelled) return;
        setDiffData(diffRes);
        setCommitsData(commitsRes);
        setUsage(allTime?.current ?? null);
        setRecentUsage(recent?.current.timeseries ?? []);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, taskId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return { diffData, commitsData, usage, recentUsage, isLoading, reload };
}

/** The task's Linked Projects (ACP additional directories) and the projects that can still be linked. */
export function useTaskLinkedProjects(projectId: string, taskId: string) {
  const [linkedProjects, setLinkedProjects] = useState<LinkedProjectItem[]>([]);
  const [availableProjects, setAvailableProjects] = useState<ProjectListItem[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksSaving, setLinksSaving] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset request state when navigating between tasks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLinksLoading(true);
    setLinksError(null);
    Promise.all([getLinkedProjects(projectId, taskId), listProjects()])
      .then(([links, projects]) => {
        if (cancelled) return;
        setLinkedProjects(links.linked_projects);
        setAvailableProjects(projects.projects);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load linked projects:", err);
        setLinksError("Failed to load linked projects");
      })
      .finally(() => {
        if (!cancelled) setLinksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, taskId]);

  // Several surfaces edit the same set: a stale copy here would drop their links on save.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<LinkedProjectsChangedDetail>).detail;
      if (detail?.projectId === projectId && detail.taskId === taskId) setLinkedProjects(detail.linkedProjects);
    };
    window.addEventListener(LINKED_PROJECTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LINKED_PROJECTS_CHANGED_EVENT, onChanged);
  }, [projectId, taskId]);

  const saveLinkedProjects = async (projectIds: string[]): Promise<boolean> => {
    if (linksSaving) return false;
    setLinksSaving(true);
    setLinksError(null);
    try {
      const result = await updateLinkedProjects(projectId, taskId, projectIds);
      setLinkedProjects(result.linked_projects);
      window.dispatchEvent(new CustomEvent<LinkedProjectsChangedDetail>(LINKED_PROJECTS_CHANGED_EVENT, {
        detail: { projectId, taskId, linkedProjects: result.linked_projects },
      }));
      return true;
    } catch (err) {
      console.error("Failed to update linked projects:", err);
      setLinksError("Failed to update linked projects");
      return false;
    } finally {
      setLinksSaving(false);
    }
  };

  const linkedIds = new Set(linkedProjects.map((project) => project.id));
  const linkCandidates = availableProjects.filter(
    (project) => project.id !== projectId && project.exists && !linkedIds.has(project.id),
  );

  return {
    linkedProjects,
    linkedIds,
    linkCandidates,
    linksLoading,
    linksSaving,
    linksError,
    saveLinkedProjects,
    link: (id: string) => saveLinkedProjects([...linkedIds, id]),
    unlink: (id: string) => saveLinkedProjects(linkedProjects.filter((item) => item.id !== id).map((item) => item.id)),
  };
}

/** Open a linked project's dashboard. */
export function openLinkedProject(projectId: string) {
  window.dispatchEvent(new CustomEvent("grove:navigate", { detail: { route: "dashboard", project_id: projectId } }));
}
