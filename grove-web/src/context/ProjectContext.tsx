import { createContext, useContext, useState, useEffect, useCallback } from "react";
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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load projects on mount
  const loadProjects = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const projectList = await listProjects();
      setProjects(projectList.map(convertProjectListItem));
    } catch (err) {
      console.error("Failed to load projects:", err);
      setError("Failed to load projects");
      setProjects([]);
    } finally {
      setIsLoading(false);
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

  // Auto-select saved project after projects are loaded
  useEffect(() => {
    if (isLoading || projects.length === 0) return;

    const savedProjectId = localStorage.getItem("grove-selected-project");

    if (savedProjectId) {
      const found = projects.find((p) => p.id === savedProjectId);
      if (found) {
        // Load full project details
        loadProjectDetails(found.id).then((fullProject) => {
          if (fullProject) {
            setSelectedProject(fullProject);
          }
        });
        return;
      }
    }

    // Default to first project
    if (projects.length > 0) {
      loadProjectDetails(projects[0].id).then((fullProject) => {
        if (fullProject) {
          setSelectedProject(fullProject);
          localStorage.setItem("grove-selected-project", fullProject.id);
        }
      });
    }
  }, [isLoading, projects, loadProjectDetails]);

  const selectProject = useCallback(
    async (project: Project | null) => {
      if (project) {
        // Load full project details
        const fullProject = await loadProjectDetails(project.id);
        if (fullProject) {
          setSelectedProject(fullProject);
          localStorage.setItem("grove-selected-project", fullProject.id);
        }
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
