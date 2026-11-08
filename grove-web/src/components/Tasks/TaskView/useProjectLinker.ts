import type { ProjectListItem } from "../../../api";
import { useTaskLinkedProjects } from "../TaskDetail/tabs/useTaskStats";

export const NO_LINKABLE_PROJECTS = "No more coding projects to link";

/** Links a coding Project to the task from a panel that can show it. */
export interface ProjectLinker {
  /** Only coding Projects: Review and Editor can't show anything else. */
  projects: ProjectListItem[];
  disabled: boolean;
  error: string | null;
  loading: boolean;
  /** Already links a Project the panel can show (it's on its way down as a prop). */
  hasReviewable: boolean;
  link: (project: ProjectListItem) => void;
}

/** `onLinked` selects the new Project: linking from a panel means wanting to see it. */
export function useProjectLinker(projectId: string, taskId: string, onLinked: (projectId: string) => void): ProjectLinker {
  const { linkedProjects, linkCandidates, linksLoading, linksSaving, linksError, link } = useTaskLinkedProjects(projectId, taskId);
  return {
    projects: linkCandidates.filter((project) => project.project_type === "repo" && !project.archived),
    disabled: linksLoading || linksSaving,
    error: linksError,
    loading: linksLoading,
    hasReviewable: linkedProjects.some((project) => project.exists && project.review_task_id),
    link: (project) => {
      void link(project.id).then((linked) => {
        if (linked) onLinked(project.id);
      });
    },
  };
}
