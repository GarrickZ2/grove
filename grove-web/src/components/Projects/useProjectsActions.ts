import { useCallback, useEffect, useState } from "react";
import { useProject } from "../../context";
import type { Project } from "../../data/types";
import { listProjects, type ProjectListItem } from "../../api";
import type { CodingTab } from "./AddProjectDialog";

export type AddProjectMode = "coding" | "studio";

export function convertArchivedProject(item: ProjectListItem): Project {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    currentBranch: "",
    tasks: [],
    localTask: null,
    addedAt: new Date(item.added_at),
    taskCount: item.task_count,
    isGitRepo: item.is_git_repo,
    exists: item.exists,
    projectType: item.project_type === "studio" ? "studio" : "repo",
    archived: true,
  };
}

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err) {
    // Backend returns specific error messages in the body; prefer them.
    return (err as { message: string }).message || fallback;
  }
  return fallback;
}

/**
 * Everything the Projects page does to projects: the archived list, the
 * add / clone / create / delete / rename / archive / restore handlers, and
 * the Add and Delete dialog state. Shared by the Workbench and Orbit pages.
 */
export function useProjectsActions(onNavigate?: (page: string) => void) {
  const { selectProject, addProject, createNewProject, cloneProject, deleteProject, renameProject, archiveProject, restoreProject, refreshProjects } = useProject();
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [projectActionId, setProjectActionId] = useState<string | null>(null);
  const [addDialogMode, setAddDialogMode] = useState<AddProjectMode>("coding");
  const [addCodingTab, setAddCodingTab] = useState<CodingTab>("existing");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshArchivedProjects = useCallback(async () => {
    const response = await listProjects(true);
    setArchivedProjects(response.projects.map(convertArchivedProject));
  }, []);

  // Refresh project list when navigating to this page
  useEffect(() => {
    void refreshProjects();
    void (async () => {
      const response = await listProjects(true);
      setArchivedProjects(response.projects.map(convertArchivedProject));
    })();
  }, [refreshProjects]);

  const openAddDialog = (mode: AddProjectMode, codingTab: CodingTab = "existing") => {
    setAddDialogMode(mode);
    setAddCodingTab(codingTab);
    setShowAddDialog(true);
    setError(null);
  };

  const closeAddDialog = () => {
    setShowAddDialog(false);
    setError(null);
  };

  const runAdd = async (action: () => Promise<Project>, label: string) => {
    try {
      setIsAdding(true);
      setError(null);
      const project = await action();
      selectProject(project);
      setShowAddDialog(false);
    } catch (err: unknown) {
      console.error(`Failed to ${label} project:`, err);
      setError(errorMessage(err, `Failed to ${label} project`));
    }
    setIsAdding(false);
  };

  const handleAddProject = (path: string, name?: string) => runAdd(() => addProject(path, name), "add");
  const handleCloneProject = (url: string, name?: string) => runAdd(() => cloneProject(url, name), "clone");
  const handleCreateNewProject = (parentDir: string, name: string, initGit: boolean, projectType?: string) =>
    runAdd(() => createNewProject(parentDir, name, initGit, projectType), "create");

  const handleDeleteProject = async () => {
    if (projectToDelete) {
      try {
        setIsDeleting(true);
        setError(null);
        const wasArchived = projectToDelete.archived;
        await deleteProject(projectToDelete.id);
        setProjectToDelete(null);
        if (wasArchived) await refreshArchivedProjects();
      } catch (err) {
        console.error("Failed to delete project:", err);
        setError("Failed to delete project");
      }
      setIsDeleting(false);
    }
  };

  const handleSelectProject = (project: Project) => {
    selectProject(project);
  };

  /** Select the project and go to its dashboard. */
  const handleOpenProject = (project: Project) => {
    selectProject(project);
    onNavigate?.("dashboard");
  };

  const handleRenameProject = async (project: Project, newName: string) => {
    await renameProject(project.id, newName);
    if (project.archived) await refreshArchivedProjects();
  };

  const runProjectAction = async (project: Project, action: (id: string) => Promise<void>, label: string) => {
    try {
      setProjectActionId(project.id);
      setError(null);
      await action(project.id);
      await refreshArchivedProjects();
    } catch (err) {
      console.error(`Failed to ${label} project:`, err);
      setError(`Failed to ${label} project`);
    } finally {
      setProjectActionId(null);
    }
  };

  const handleArchiveProject = (project: Project) => runProjectAction(project, archiveProject, "archive");
  const handleRestoreProject = (project: Project) => runProjectAction(project, restoreProject, "restore");

  return {
    archivedProjects,
    projectActionId,
    addDialogMode,
    addCodingTab,
    showAddDialog,
    projectToDelete,
    setProjectToDelete,
    isAdding,
    isDeleting,
    error,
    setError,
    openAddDialog,
    closeAddDialog,
    handleAddProject,
    handleCloneProject,
    handleCreateNewProject,
    handleDeleteProject,
    handleSelectProject,
    handleOpenProject,
    handleRenameProject,
    handleArchiveProject,
    handleRestoreProject,
  };
}

export type ProjectsActions = ReturnType<typeof useProjectsActions>;
