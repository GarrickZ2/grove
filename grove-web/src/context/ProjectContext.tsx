import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import type { Project } from "../data/types";
import { mockProjects } from "../data/mockData";

interface ProjectContextType {
  selectedProject: Project | null;
  projects: Project[];
  selectProject: (project: Project | null) => void;
  isLoading: boolean;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Simulate startup logic: auto-select first project (simulating launch within git repo)
  useEffect(() => {
    const savedProjectId = localStorage.getItem("grove-selected-project");

    if (savedProjectId) {
      const found = mockProjects.find((p) => p.id === savedProjectId);
      if (found) {
        setSelectedProject(found);
      }
    } else if (mockProjects.length > 0) {
      // Default to first project (simulates launching inside a git repo)
      setSelectedProject(mockProjects[0]);
    }

    setIsLoading(false);
  }, []);

  const selectProject = useCallback((project: Project | null) => {
    setSelectedProject(project);
    if (project) {
      localStorage.setItem("grove-selected-project", project.id);
    } else {
      localStorage.removeItem("grove-selected-project");
    }
  }, []);

  return (
    <ProjectContext.Provider
      value={{
        selectedProject,
        projects: mockProjects,
        selectProject,
        isLoading,
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
