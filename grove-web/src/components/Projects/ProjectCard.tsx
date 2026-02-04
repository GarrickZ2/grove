import { motion } from "framer-motion";
import { Folder, Trash2, Circle } from "lucide-react";
import type { Project } from "../../data/types";

interface ProjectCardProps {
  project: Project;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function ProjectCard({ project, isSelected, onSelect, onDelete }: ProjectCardProps) {
  const liveTasks = project.tasks.filter((t) => t.status === "live").length;
  const activeTasks = project.tasks.filter((t) => t.status !== "archived").length;

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onSelect}
      className={`
        relative p-4 rounded-xl border cursor-pointer transition-colors
        ${
          isSelected
            ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
            : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50"
        }
      `}
    >
      {/* Selected indicator */}
      {isSelected && (
        <div className="absolute top-3 right-3">
          <div className="w-2 h-2 rounded-full bg-[var(--color-highlight)]" />
        </div>
      )}

      {/* Project icon and name */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-lg bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
          <Folder className="w-5 h-5 text-[var(--color-highlight)]" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-[var(--color-text)] truncate">
            {project.name}
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] truncate">
            {project.path}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 text-xs">
        {/* Live tasks */}
        <div className="flex items-center gap-1.5">
          <Circle
            className="w-3 h-3"
            style={{
              color: liveTasks > 0 ? "var(--color-success)" : "var(--color-text-muted)",
              fill: liveTasks > 0 ? "var(--color-success)" : "transparent",
            }}
          />
          <span className={liveTasks > 0 ? "text-[var(--color-success)]" : "text-[var(--color-text-muted)]"}>
            {liveTasks} Live
          </span>
        </div>

        {/* Active tasks */}
        <span className="text-[var(--color-text-muted)]">
          {activeTasks} Active
        </span>
      </div>

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute bottom-3 right-3 p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-error)] hover:bg-[var(--color-error)]/10 transition-colors"
        title="Delete project"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </motion.div>
  );
}
