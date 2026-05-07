import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import type { Project, Task } from "../data/types";
import {
  listProjects,
  getProject,
  addProject as apiAddProject,
  createNewProject as apiCreateNewProject,
  deleteProject as apiDeleteProject,
  renameProject as apiRenameProject,
  type ProjectListItem,
  type ProjectResponse,
  type TaskResponse,
} from "../api";

interface ProjectContextType {
  selectedProject: Project | null;
  projects: Project[];
  /** ID of the project matching the server's current working directory */
  currentProjectId: string | null;
  selectProject: (project: Project | null) => void;
  addProject: (path: string, name?: string) => Promise<Project>;
  createNewProject: (parentDir: string, name: string, initGit: boolean, projectType?: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshSelectedProject: () => Promise<void>;
  /**
   * Directly replace the selected project with a pre-fetched API response.
   * Use this when you have fresh data from an API call and want to avoid an
   * extra `getProject` round-trip. Also refreshes the projects list in the
   * background.
   */
  applySelectedProject: (response: ProjectResponse) => void;
  isLoading: boolean;
  error: string | null;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

/** Normalize API project_type to the frontend union type. */
function normalizeProjectType(apiType: string | undefined): 'repo' | 'studio' {
  if (apiType === 'studio') return 'studio';
  return 'repo'; // default for undefined, 'repo', and any future types
}

// Convert API TaskResponse to frontend Task type
function convertTask(task: TaskResponse): Task {
  return {
    id: task.id,
    name: task.name,
    branch: task.branch,
    target: task.target,
    status: task.status === "archived" ? "archived" : "active",
    createdAt: new Date(task.created_at),
    updatedAt: new Date(task.updated_at),
    multiplexer: task.multiplexer || "tmux",
    createdBy: task.created_by || "",
    isLocal: task.is_local || false,
  };
}

// Convert API ProjectResponse to frontend Project type
function convertProject(project: ProjectResponse): Project {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    currentBranch: project.current_branch,
    tasks: project.tasks.map(convertTask),
    localTask: project.local_task ? convertTask(project.local_task) : null,
    addedAt: new Date(project.added_at),
    isGitRepo: project.is_git_repo,
    exists: project.exists,
    projectType: normalizeProjectType(project.project_type),
  };
}

// Convert ProjectListItem to a minimal Project (without full tasks)
function convertProjectListItem(item: ProjectListItem): Project {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    currentBranch: "", // Will be loaded when selected
    tasks: [], // Will be loaded when selected
    localTask: null, // Will be loaded when selected
    addedAt: new Date(item.added_at),
    taskCount: item.task_count,
    isGitRepo: item.is_git_repo,
    exists: item.exists,
    projectType: normalizeProjectType(item.project_type),
  };
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load projects — only shows full-page loading spinner on the initial load.
  // Subsequent refreshes update data silently to avoid unmounting the current page.
  const initialLoadDone = useRef(false);
  const loadProjects = useCallback(async () => {
    const isInitial = !initialLoadDone.current;
    try {
      if (isInitial) setIsLoading(true);
      setError(null);
      const response = await listProjects();
      setProjects(response.projects.map(convertProjectListItem));
      setCurrentProjectId(response.current_project_id);
      initialLoadDone.current = true;
    } catch (err) {
      console.error("Failed to load projects:", err);
      setError("Failed to load projects");
      setProjects([]);
      setCurrentProjectId(null);
    }
    if (isInitial) setIsLoading(false);
  }, []);

  // Load full project data when selected
  const loadProjectDetails = useCallback(async (projectId: string) => {
    try {
      const project = await getProject(projectId);
      return convertProject(project);
    } catch (err) {
      console.error("Failed to load project details:", err);
      return null;
    }
  }, []);

  // Initial load
  useEffect(() => {
    void (async () => {
      await loadProjects();
    })();
  }, [loadProjects]);

  // Track selectedProject in a ref so the auto-select effect can read it
  // without re-triggering when it changes (which would cause a loop).
  const selectedProjectRef = useRef(selectedProject);
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  });

  // Auto-select project after projects are loaded
  // Priority: currentProjectId (from server cwd) > savedProjectId > first project
  // Only runs when no project is currently selected.
  useEffect(() => {
    if (isLoading || projects.length === 0 || selectedProjectRef.current) return;

    // Priority 1: If server is running in a registered project directory, select it
    if (currentProjectId) {
      const found = projects.find((p) => p.id === currentProjectId);
      if (found) {
        loadProjectDetails(found.id).then((fullProject) => {
          if (fullProject) {
            setSelectedProject(fullProject);
            localStorage.setItem("grove-selected-project", fullProject.id);
          }
        });
        return;
      }
    }

    // Priority 2: Use saved project from localStorage
    const savedProjectId = localStorage.getItem("grove-selected-project");
    if (savedProjectId) {
      const found = projects.find((p) => p.id === savedProjectId);
      if (found) {
        loadProjectDetails(found.id).then((fullProject) => {
          if (fullProject) {
            setSelectedProject(fullProject);
          }
        });
        return;
      }
    }

    // Priority 3: Default to first project
    if (projects.length > 0) {
      loadProjectDetails(projects[0].id).then((fullProject) => {
        if (fullProject) {
          setSelectedProject(fullProject);
          localStorage.setItem("grove-selected-project", fullProject.id);
        }
      });
    }
  }, [isLoading, projects, currentProjectId, loadProjectDetails]);

  const selectProject = useCallback(
    (project: Project | null) => {
      if (project) {
        // Set basic project info immediately for instant navigation
        setSelectedProject(project);
        localStorage.setItem("grove-selected-project", project.id);
        // Load full project details in background
        loadProjectDetails(project.id).then((fullProject) => {
          if (fullProject) {
            setSelectedProject(fullProject);
          }
        });
      } else {
        setSelectedProject(null);
        localStorage.removeItem("grove-selected-project");
      }
    },
    [loadProjectDetails]
  );

  const addProject = useCallback(
    async (path: string, name?: string): Promise<Project> => {
      const response = await apiAddProject(path, name);
      const newProject = convertProject(response);
      await loadProjects(); // Refresh the list
      return newProject;
    },
    [loadProjects]
  );

  const createNewProject = useCallback(
    async (parentDir: string, name: string, initGit: boolean, projectType?: string): Promise<Project> => {
      const response = await apiCreateNewProject(parentDir, name, initGit, projectType);
      const newProject = convertProject(response);
      await loadProjects();
      return newProject;
    },
    [loadProjects]
  );

  const deleteProject = useCallback(
    async (id: string): Promise<void> => {
      await apiDeleteProject(id);

      // If deleted project was selected, clear selection
      if (selectedProject?.id === id) {
        setSelectedProject(null);
        localStorage.removeItem("grove-selected-project");
      }

      await loadProjects(); // Refresh the list
    },
    [selectedProject, loadProjects]
  );

  const refreshProjects = useCallback(async () => {
    await loadProjects();
  }, [loadProjects]);

  const applySelectedProject = useCallback(
    (response: ProjectResponse) => {
      setSelectedProject(convertProject(response));
      void loadProjects();
    },
    [loadProjects],
  );

  const refreshSelectedProject = useCallback(async () => {
    if (selectedProject) {
      const [fullProject] = await Promise.all([
        loadProjectDetails(selectedProject.id),
        loadProjects(),
      ]);
      if (fullProject) {
        setSelectedProject(fullProject);
      }
    }
  }, [selectedProject, loadProjectDetails, loadProjects]);

  const renameProject = useCallback(
    async (id: string, name: string): Promise<void> => {
      await apiRenameProject(id, name);
      if (selectedProject?.id === id) {
        await refreshSelectedProject();
      } else {
        await loadProjects();
      }
    },
    [selectedProject, refreshSelectedProject, loadProjects]
  );

  return (
    <ProjectContext.Provider
      value={{
        selectedProject,
        projects,
        currentProjectId,
        selectProject,
        addProject,
        createNewProject,
        applySelectedProject,
        deleteProject,
        renameProject,
        refreshProjects,
        refreshSelectedProject,
        isLoading,
        error,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProject must be used within ProjectProvider");
  }
  return context;
}
