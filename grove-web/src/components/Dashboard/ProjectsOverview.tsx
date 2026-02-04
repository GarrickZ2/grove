import { motion } from "framer-motion";
import { FolderGit2, Circle, ChevronRight } from "lucide-react";
import type { Project } from "../../data/types";

interface ProjectsOverviewProps {
  projects: Project[];
  onProjectClick: (project: Project) => void;
}

export function ProjectsOverview({ projects, onProjectClick }: ProjectsOverviewProps) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--color-text)]">
          Projects
        </h2>
        <span className="text-xs text-[var(--color-text-muted)]">
          {projects.length} project{projects.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="p-4">
        <div className="flex gap-3 overflow-x-auto pb-2 -mb-2">
          {projects.map((project, index) => {
            const liveTasks = project.tasks.filter(t => t.status === "live").length;
            const totalTasks = project.tasks.length;

            return (
              <motion.button
                key={project.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => onProjectClick(project)}
                className="flex-shrink-0 w-44 p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-highlight)] hover:bg-[var(--color-bg-tertiary)] transition-all group text-left"
              >
                {/* Icon */}
                <div className="w-10 h-10 rounded-lg bg-[var(--color-highlight)]/10 flex items-center justify-center mb-3">
                  <FolderGit2 className="w-5 h-5 text-[var(--color-highlight)]" />
                </div>

                {/* Name */}
                <div className="font-medium text-[var(--color-text)] mb-1 truncate">
                  {project.name}
                </div>

                {/* Stats */}
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <span>{totalTasks} task{totalTasks !== 1 ? "s" : ""}</span>
                  {liveTasks > 0 && (
                    <>
                      <span>•</span>
                      <span className="flex items-center gap-1 text-[var(--color-success)]">
                        <Circle className="w-2 h-2 fill-current" />
                        {liveTasks} live
                      </span>
                    </>
                  )}
                </div>

                {/* Arrow */}
                <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity absolute top-4 right-4" />
              </motion.button>
            );
          })}

          {/* View All Card */}
          <motion.button
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: projects.length * 0.05 }}
            className="flex-shrink-0 w-44 p-4 rounded-xl border border-dashed border-[var(--color-border)] hover:border-[var(--color-text-muted)] transition-colors flex flex-col items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <ChevronRight className="w-6 h-6 mb-2" />
            <span className="text-sm">View All</span>
          </motion.button>
        </div>
      </div>
    </div>
  );
}
