import { useEffect, useState } from "react";
import { getProject, listProjects, listResources, type ProjectListItem } from "../../../api/projects";
import { getTaskFiles, listTasks } from "../../../api/tasks";
import type { ProjectMentionContent } from "./projectMentions";

/** Keep cached choices visible; refresh once on each entry, never on each keystroke. */
export function useProjectMentions(open: boolean, filter: string) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState(false);
  const [contents, setContents] = useState<Record<string, ProjectMentionContent>>({});
  const [previousOpen, setPreviousOpen] = useState(false);
  // Reset pending state with the input transition, before rendering the menu.
  // The effects only perform I/O and publish its results.
  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) {
      setProjectsLoading(true);
      setProjectsError(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    void listProjects().then(result => {
      if (active) setProjects(result.projects);
    }).catch(() => {
      if (active) setProjectsError(true);
    }).finally(() => {
      if (active) setProjectsLoading(false);
    });
    return () => { active = false; };
  }, [open]);

  const slash = filter.indexOf("/");
  const name = slash >= 0 ? filter.slice(0, slash).toLowerCase() : null;
  const project = projects.find(item => item.name.toLowerCase() === name);
  const projectId = project?.id;
  const projectType = project?.project_type;
  const selectionKey = open && projectId ? JSON.stringify([projectId, projectType]) : null;
  const [previousSelection, setPreviousSelection] = useState<string | null>(null);
  if (selectionKey !== previousSelection) {
    setPreviousSelection(selectionKey);
    if (selectionKey && projectId) {
      setContents(previous => ({
        ...previous,
        [projectId]: { ...previous[projectId], filesLoading: true, tasksLoading: true, filesError: false, tasksError: false },
      }));
    }
  }

  useEffect(() => {
    if (!open || !projectId) return;
    let active = true;
    const update = (patch: Partial<ProjectMentionContent>) => {
      if (!active) return;
      setContents(previous => ({
        ...previous,
        [projectId]: { ...(previous[projectId] ?? { filesLoading: true, tasksLoading: true }), ...patch },
      }));
    };
    void listTasks(projectId, "active").then(tasks => {
      update({ tasks, tasksLoading: false });
    }).catch(() => update({ tasksError: true, tasksLoading: false }));
    const loadFiles = async () => {
      if (projectType === "studio") return (await listResources(projectId)).files.map(file => file.path);
      const detail = await getProject(projectId);
      return detail.local_task ? (await getTaskFiles(projectId, detail.local_task.id)).files : [];
    };
    void loadFiles().then(files => {
      update({ files, filesLoading: false });
    }).catch(() => update({ filesError: true, filesLoading: false }));
    return () => { active = false; };
  }, [open, projectId, projectType]);

  return { projects, projectsLoading, projectsError, contents };
}
