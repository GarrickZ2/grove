import { useState } from "react";
import { motion } from "framer-motion";
import { Plus, FolderGit2 } from "lucide-react";
import { Button } from "../ui";
import { ProjectCard } from "./ProjectCard";
import { AddProjectDialog } from "./AddProjectDialog";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { useProject } from "../../context";
import type { Project } from "../../data/types";

export function ProjectsPage() {
  const { projects, selectedProject, selectProject } = useProject();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const handleAddProject = (path: string) => {
    console.log("Adding project:", path);
    // TODO: Implement actual project addition
  };

  const handleDeleteProject = () => {
    if (projectToDelete) {
      console.log("Deleting project:", projectToDelete.name);
      // TODO: Implement actual project deletion
      setProjectToDelete(null);
    }
  };

  const handleSelectProject = (project: Project) => {
    selectProject(project);
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
        <Button onClick={() => setShowAddDialog(true)} size="sm">
          <Plus className="w-4 h-4 mr-1.5" />
          Add Project
        </Button>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
                onDelete={() => setProjectToDelete(project)}
              />
            </motion.div>
          ))}

          {/* Add Project Card */}
          <motion.button
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: projects.length * 0.05 }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setShowAddDialog(true)}
            className="p-4 rounded-xl border-2 border-dashed border-[var(--color-border)] hover:border-[var(--color-highlight)] bg-transparent hover:bg-[var(--color-bg-secondary)] transition-colors flex flex-col items-center justify-center min-h-[140px]"
          >
            <Plus className="w-8 h-8 text-[var(--color-text-muted)] mb-2" />
            <span className="text-sm text-[var(--color-text-muted)]">Add Project</span>
          </motion.button>
        </div>
      )}

      {/* Dialogs */}
      <AddProjectDialog
        isOpen={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onAdd={handleAddProject}
      />

      <DeleteProjectDialog
        isOpen={projectToDelete !== null}
        project={projectToDelete}
        onClose={() => setProjectToDelete(null)}
        onConfirm={handleDeleteProject}
      />
    </motion.div>
  );
}
