import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import type { Project, Task, TaskStatus } from "../data/types";
import {
  listProjects,
  getProject,
  addProject as apiAddProject,
  deleteProject as apiDeleteProject,
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
  deleteProject: (id: string) => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshSelectedProject: () => Promise<void>;
  isLoading: boolean;
  error: string | null;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

// Convert API TaskResponse to frontend Task type
function convertTask(task: TaskResponse): Task {
  return {
    id: task.id,
    name: task.name,
    branch: task.branch,
    target: task.target,
    status: task.status as TaskStatus,
    additions: task.additions,
    deletions: task.deletions,
    filesChanged: task.files_changed,
    commits: task.commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: "author", // API doesn't provide author yet
      date: new Date(), // API provides time_ago, not exact date
    })),
    createdAt: new Date(task.created_at),
    updatedAt: new Date(task.updated_at),
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
    addedAt: new Date(project.added_at),
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
    addedAt: new Date(item.added_at),
    taskCount: item.task_count,
    liveCount: item.live_count,
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
    } finally {
      if (isInitial) setIsLoading(false);
    }
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
    loadProjects();
  }, [loadProjects]);

  // Auto-select project after projects are loaded
  // Priority: currentProjectId (from server cwd) > savedProjectId > first project
  // Only runs when no project is currently selected.
  useEffect(() => {
    if (isLoading || projects.length === 0 || selectedProject) return;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const refreshSelectedProject = useCallback(async () => {
    if (selectedProject) {
      const fullProject = await loadProjectDetails(selectedProject.id);
      if (fullProject) {
        setSelectedProject(fullProject);
      }
    }
  }, [selectedProject, loadProjectDetails]);

  return (
    <ProjectContext.Provider
      value={{
        selectedProject,
        projects,
        currentProjectId,
        selectProject,
        addProject,
        deleteProject,
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

export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProject must be used within ProjectProvider");
  }
  return context;
}
