import { motion } from "framer-motion";
import { Trash2, Circle } from "lucide-react";
import type { Project } from "../../data/types";
import { getProjectStyle } from "../../utils/projectStyle";
import { useTheme } from "../../context";

interface ProjectCardProps {
  project: Project;
  isSelected: boolean;
  onSelect: () => void;
  onDoubleClick?: () => void;
  onDelete: () => void;
}

export function ProjectCard({ project, isSelected, onSelect, onDoubleClick, onDelete }: ProjectCardProps) {
  const { theme } = useTheme();
  // Use taskCount/liveCount from list response, fallback to calculating from tasks array
  const taskCount = project.taskCount ?? project.tasks.length;
  const liveCount = project.liveCount ?? project.tasks.filter((t) => t.status === "live").length;
  const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
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
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: color.bg }}
        >
          <Icon className="w-5 h-5" style={{ color: color.fg }} />
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
        {/* Total tasks */}
        <span className="text-[var(--color-text-muted)]">
          {taskCount} {taskCount === 1 ? "Task" : "Tasks"}
        </span>

        {/* Live tasks */}
        <div className="flex items-center gap-1.5">
          <Circle
            className="w-3 h-3"
            style={{
              color: liveCount > 0 ? "var(--color-success)" : "var(--color-text-muted)",
              fill: liveCount > 0 ? "var(--color-success)" : "transparent",
            }}
          />
          <span className={liveCount > 0 ? "text-[var(--color-success)]" : "text-[var(--color-text-muted)]"}>
            {liveCount} Live
          </span>
        </div>
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
