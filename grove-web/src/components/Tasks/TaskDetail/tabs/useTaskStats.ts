import { useCallback, useEffect, useState } from "react";
import {
  getTaskStats,
  getDiff,
  getCommits,
  getLinkedProjects,
  updateLinkedProjects,
  listProjects,
  type TaskStatsResponse,
  type DiffResponse,
  type CommitsResponse,
  type LinkedProjectItem,
  type ProjectListItem,
} from "../../../../api";
import {
  LINKED_PROJECTS_CHANGED_EVENT,
  type LinkedProjectsChangedDetail,
} from "../../../../hooks/useLinkedReviewProjects";

/**
 * Task Info data shared by the Workbench and Orbit renders: edit stats, the
 * branch diff and its commits. Diff and commits are best-effort (Studio tasks
 * have neither), so only a stats failure counts as an error.
 */
export function useTaskStats(projectId: string, taskId: string) {
  const [stats, setStats] = useState<TaskStatsResponse | null>(null);
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [commitsData, setCommitsData] = useState<CommitsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);

    setError(null);
    Promise.all([
      getTaskStats(projectId, taskId),
      getDiff(projectId, taskId).catch(() => null),
      getCommits(projectId, taskId).catch(() => null),
    ])
      .then(([statsRes, diffRes, commitsRes]) => {
        setStats(statsRes);
        setDiffData(diffRes);
        setCommitsData(commitsRes);
      })
      .catch((err) => {
        console.error("Failed to load task stats:", err);
        setError("Failed to load stats");
      })
      .finally(() => setIsLoading(false));
  }, [projectId, taskId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return { stats, diffData, commitsData, isLoading, error, reload };
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

  const saveLinkedProjects = async (projectIds: string[]) => {
    if (linksSaving) return;
    setLinksSaving(true);
    setLinksError(null);
    try {
      const result = await updateLinkedProjects(projectId, taskId, projectIds);
      setLinkedProjects(result.linked_projects);
      window.dispatchEvent(new CustomEvent<LinkedProjectsChangedDetail>(LINKED_PROJECTS_CHANGED_EVENT, {
        detail: { projectId, taskId, linkedProjects: result.linked_projects },
      }));
    } catch (err) {
      console.error("Failed to update linked projects:", err);
      setLinksError("Failed to update linked projects");
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
