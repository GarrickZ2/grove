import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Plus, FolderGit2 } from "lucide-react";
import { Button } from "../ui";
import { ProjectCard } from "./ProjectCard";
import { AddProjectDialog } from "./AddProjectDialog";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { useProject } from "../../context";
import { useIsMobile } from "../../hooks";
import type { Project } from "../../data/types";

interface ProjectsPageProps {
  onNavigate?: (page: string) => void;
}

export function ProjectsPage({ onNavigate }: ProjectsPageProps) {
  const { projects, selectedProject, selectProject, addProject, deleteProject, refreshProjects } = useProject();
  const { isMobile } = useIsMobile();

  // Refresh project list when navigating to this page
  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddProject = async (path: string, name?: string) => {
    try {
      setIsAdding(true);
      setError(null);
      await addProject(path, name);
      setShowAddDialog(false);
    } catch (err: unknown) {
      console.error("Failed to add project:", err);
      if (err && typeof err === "object" && "status" in err) {
        const apiErr = err as { status: number; message: string };
        if (apiErr.status === 409) {
          setError("Project already registered");
        } else if (apiErr.status === 400) {
          setError("Invalid path or not a git repository");
        } else {
          setError("Failed to add project");
        }
      } else {
        setError("Failed to add project");
      }
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteProject = async () => {
    if (projectToDelete) {
      try {
        setIsDeleting(true);
        setError(null);
        await deleteProject(projectToDelete.id);
        setProjectToDelete(null);
      } catch (err) {
        console.error("Failed to delete project:", err);
        setError("Failed to delete project");
      } finally {
        setIsDeleting(false);
      }
    }
  };

  const handleSelectProject = (project: Project) => {
    selectProject(project);
  };

  const handleDoubleClick = (project: Project) => {
    selectProject(project);
    onNavigate?.("dashboard");
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Projects</h1>
        {!isMobile && (
          <Button onClick={() => setShowAddDialog(true)} size="sm">
            <Plus className="w-4 h-4 mr-1.5" />
            Add Project
          </Button>
        )}
      </div>

      {/* Projects Grid */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <FolderGit2 className="w-12 h-12 text-[var(--color-text-muted)] mb-4" />
          <p className="text-[var(--color-text-muted)] mb-4">No projects yet</p>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add Your First Project
          </Button>
        </div>
      ) : (
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 ${isMobile ? "gap-2" : "gap-4"}`}>
          {projects.map((project, index) => (
            <motion.div
              key={project.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
            >
              <ProjectCard
                project={project}
                isSelected={selectedProject?.id === project.id}
                onSelect={() => handleSelectProject(project)}
                onDoubleClick={() => handleDoubleClick(project)}
                onDelete={() => setProjectToDelete(project)}
                compact={isMobile}
              />
            </motion.div>
          ))}

          {/* Add Project Card — hidden on mobile */}
          {!isMobile && (
            <motion.button
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: projects.length * 0.05 }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setShowAddDialog(true)}
              className="p-4 rounded-xl border-2 border-dashed border-[var(--color-border)] hover:border-[var(--color-highlight)] bg-transparent hover:bg-[var(--color-bg-secondary)] transition-colors flex items-center justify-center gap-2"
            >
              <Plus className="w-5 h-5 text-[var(--color-text-muted)]" />
              <span className="text-sm text-[var(--color-text-muted)]">Add Project</span>
            </motion.button>
          )}
        </div>
      )}

      {/* Dialogs */}
      <AddProjectDialog
        isOpen={showAddDialog}
        onClose={() => {
          setShowAddDialog(false);
          setError(null);
        }}
        onAdd={handleAddProject}
        isLoading={isAdding}
        externalError={error}
      />

      <DeleteProjectDialog
        isOpen={projectToDelete !== null}
        project={projectToDelete}
        onClose={() => setProjectToDelete(null)}
        onConfirm={handleDeleteProject}
        isLoading={isDeleting}
      />
    </motion.div>
  );
}
