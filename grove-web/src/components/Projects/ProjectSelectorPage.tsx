import { motion } from "framer-motion";
import { FolderGit2, Plus, ArrowRight } from "lucide-react";
import { useProject } from "../../context";
import type { Project } from "../../data/types";

interface ProjectSelectorPageProps {
  onProjectSelected?: () => void;
}

export function ProjectSelectorPage({ onProjectSelected }: ProjectSelectorPageProps) {
  const { projects, selectProject } = useProject();

  const handleSelectProject = (project: Project) => {
    selectProject(project);
    onProjectSelected?.();
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-4xl"
      >
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--color-highlight)] to-[var(--color-accent)] mb-4">
            <span className="text-white font-bold text-2xl">G</span>
          </div>
          <h1 className="text-3xl font-bold text-[var(--color-text)] mb-2">
            Welcome to Grove
          </h1>
          <p className="text-[var(--color-text-muted)]">
            Select a project to get started
          </p>
        </div>

        {/* Project Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {projects.map((project, index) => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => handleSelectProject(project)}
              index={index}
            />
          ))}

          {/* Add Project Card */}
          <motion.button
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: projects.length * 0.05, duration: 0.3 }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="flex flex-col items-center justify-center p-6 rounded-xl border-2 border-dashed border-[var(--color-border)] hover:border-[var(--color-highlight)] hover:bg-[var(--color-bg-secondary)] transition-all min-h-[160px]"
          >
            <div className="w-12 h-12 rounded-xl bg-[var(--color-bg-tertiary)] flex items-center justify-center mb-3">
              <Plus className="w-6 h-6 text-[var(--color-text-muted)]" />
            </div>
            <span className="text-sm font-medium text-[var(--color-text-muted)]">
              Add Project
            </span>
            <span className="text-xs text-[var(--color-text-muted)] mt-1">
              Drop folder or click to browse
            </span>
          </motion.button>
        </div>

        {/* Help Text */}
        <div className="text-center text-sm text-[var(--color-text-muted)]">
          <p>
            You can also run <code className="px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-highlight)]">grove web</code> inside a git repository to auto-select it.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
  index: number;
}

function ProjectCard({ project, onClick, index }: ProjectCardProps) {
  const liveCount = project.tasks.filter((t) => t.status === "live").length;
  const totalCount = project.tasks.length;

  return (
    <motion.button
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.3 }}
      whileHover={{ scale: 1.02, y: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="group text-left p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-[var(--color-highlight)] hover:shadow-lg transition-all"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-lg bg-[var(--color-bg-tertiary)] flex items-center justify-center">
          <FolderGit2 className="w-5 h-5 text-[var(--color-highlight)]" />
        </div>
        <ArrowRight className="w-4 h-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
      </div>

      <h3 className="text-lg font-semibold text-[var(--color-text)] mb-1">
        {project.name}
      </h3>
      <p className="text-xs text-[var(--color-text-muted)] truncate mb-3">
        {project.path}
      </p>

      <div className="flex items-center gap-3">
        <span className="text-sm text-[var(--color-text-muted)]">
          {totalCount} task{totalCount !== 1 ? "s" : ""}
        </span>
        {liveCount > 0 && (
          <span className="flex items-center gap-1.5 text-sm text-[var(--color-success)]">
            <span className="w-2 h-2 rounded-full bg-[var(--color-success)] animate-pulse" />
            {liveCount} live
          </span>
        )}
      </div>
    </motion.button>
  );
}
