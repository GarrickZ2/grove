import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Trash2, AlertCircle, FolderX, Sparkles, Pencil } from "lucide-react";
import type { Project } from "../../data/types";
import { getProjectStyle } from "../../utils/projectStyle";
import { compactPath } from "../../utils/pathUtils";
import { useTheme } from "../../context";
import { OptionalPerfProfiler } from "../../perf/profilerShim";

interface ProjectCardProps {
  project: Project;
  isSelected: boolean;
  onSelect: () => void;
  onDoubleClick?: () => void;
  onDelete: () => void;
  onRename: (newName: string) => Promise<void>;
  compact?: boolean;
}

export function ProjectCard(props: ProjectCardProps) {
  return (
    <OptionalPerfProfiler id={`ProjectCard:${props.project.id.slice(0, 8)}`}>
      <ProjectCardInner {...props} />
    </OptionalPerfProfiler>
  );
}

function ProjectCardInner({ project, isSelected, onSelect, onDoubleClick, onDelete, onRename, compact }: ProjectCardProps) {
  const { theme } = useTheme();
  const taskCount = project.taskCount ?? project.tasks.length;
  const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
  const isMissing = !project.exists;
  const isStudio = project.projectType === "studio";

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);
  const [isRenaming, setIsRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditName(project.name);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditName(project.name);
  };

  const submitRename = async () => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === project.name) {
      cancelEditing();
      return;
    }
    setIsRenaming(true);
    try {
      await onRename(trimmed);
      setIsEditing(false);
    } catch {
      setEditName(project.name);
    } finally {
      setIsRenaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitRename();
    } else if (e.key === "Escape") {
      cancelEditing();
    }
  };

  return (
    <motion.div
      whileHover={isMissing ? undefined : { scale: 1.02 }}
      whileTap={isMissing ? undefined : { scale: 0.98 }}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={`
        relative rounded-xl border cursor-pointer transition-colors select-none
        ${compact ? "p-3" : "p-4"}
        ${isMissing ? "opacity-50" : ""}
        ${
          isSelected
            ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
            : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50"
        }
      `}
    >
      {isSelected && (
        <div className="absolute top-3 right-3">
          <div className="w-2 h-2 rounded-full bg-[var(--color-highlight)]" />
        </div>
      )}

      <div className={`flex items-start gap-3 ${compact ? "mb-2" : "mb-3"}`}>
        <div
          className={`${compact ? "w-8 h-8" : "w-10 h-10"} rounded-lg flex items-center justify-center flex-shrink-0`}
          style={{ backgroundColor: color.bg }}
        >
          <Icon className={compact ? "w-4 h-4" : "w-5 h-5"} style={{ color: color.fg }} />
        </div>
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={submitRename}
              onKeyDown={handleKeyDown}
              disabled={isRenaming}
              onClick={(e) => e.stopPropagation()}
              className={`
                text-sm font-semibold w-full bg-transparent
                border-b border-[var(--color-highlight)] outline-none
                text-[var(--color-text)]
                ${isRenaming ? "opacity-50" : ""}
              `}
            />
          ) : (
            <h3 className="text-sm font-semibold text-[var(--color-text)] truncate">
              {project.name}
            </h3>
          )}
          <p
            className={`text-xs text-[var(--color-text-muted)] truncate ${isMissing ? "line-through" : ""}`}
          >
            {compactPath(project.path, 30)}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        {isMissing ? (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-error)]/10 text-[var(--color-error)] border border-[var(--color-error)]/20"
            title="This project's directory no longer exists on disk"
          >
            <FolderX className="w-3 h-3" />
            Missing
          </span>
        ) : isStudio ? (
          <>
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] border border-[var(--color-highlight)]/20"
            >
              <Sparkles className="w-3 h-3" />
              Studio
            </span>
            {taskCount > 0 && (
              <span className="text-[var(--color-text-muted)]">
                {taskCount} {taskCount === 1 ? "Task" : "Tasks"}
              </span>
            )}
          </>
        ) : project.isGitRepo ? (
          <span className="text-[var(--color-text-muted)]">
            {taskCount} {taskCount === 1 ? "Task" : "Tasks"}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)] border border-[var(--color-warning)]/20"
            title="This project is not a Git repository yet"
          >
            <AlertCircle className="w-3 h-3" />
            Not initialized
          </span>
        )}
      </div>

      <div className="absolute bottom-3 right-3 flex items-center gap-0.5">
        <button
          onClick={startEditing}
          className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/10 transition-colors"
          title="Rename project"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-error)] hover:bg-[var(--color-error)]/10 transition-colors"
          title="Delete project"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </motion.div>
  );
}
