import { useMemo, type ComponentProps } from "react";
import { useProject } from "../../../context";
import type { LinkedReviewProject } from "../../../hooks/useLinkedReviewProjects";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { useProjectTarget, type ProjectTarget } from "./useProjectTarget";
import { TaskEditor } from "./TaskEditor";

/**
 * The Editor panel: the task's own files, or those of a Project it links. A
 * linked Project shows its Local Task, the same files as its own page, so
 * saving there writes to that Project's folder. Each Project mounts its own
 * editor, and TaskEditor saves unsaved edits on unmount.
 */
export function LinkedTaskEditor({ linkedProjects, ...editor }: ComponentProps<typeof TaskEditor> & {
  linkedProjects?: LinkedReviewProject[];
}) {
  const { projectId, taskId } = editor;
  const { projects } = useProject();
  const ownName = projects.find((p) => p.id === projectId)?.name ?? "This task";
  const targets = useMemo<ProjectTarget[]>(() => [
    { projectId, taskId, name: ownName, linked: false },
    ...(linkedProjects ?? []).map((p) => ({ ...p, linked: true })),
  ], [projectId, taskId, ownName, linkedProjects]);
  const { active, select } = useProjectTarget(`grove:editor-target:${projectId}:${taskId}`, targets);
  return (
    <TaskEditor
      {...editor}
      key={`${active.projectId}:${active.taskId}`}
      projectId={active.projectId}
      taskId={active.taskId}
      treeTitle={targets.length > 1 ? (
        <ProjectSwitcher targets={targets} active={active} onSelect={select} verb="Editing" portal />
      ) : undefined}
    />
  );
}
