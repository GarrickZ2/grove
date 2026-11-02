import { motion } from "framer-motion";
import { Trash2, AlertCircle, FolderX, Pencil, Archive, RotateCcw } from "lucide-react";
import type { Project } from "../../data/types";
import { getProjectStyle } from "../../utils/projectStyle";
import { compactPath } from "../../utils/pathUtils";
import { useTheme } from "../../context";
import { OptionalPerfProfiler } from "../../perf/profilerShim";
import { ProjectTypeBadge } from "../ui/ProjectTypeBadge";
import { MAX_PROJECT_NAME_LEN, useProjectRename } from "./useProjectRename";

interface ProjectCardProps {
  project: Project;
  isSelected: boolean;
  onSelect: () => void;
  onDoubleClick?: () => void;
  onDelete: () => void;
  onRename: (newName: string) => Promise<void>;
  onArchive?: () => void;
  onRestore?: () => void;
  compact?: boolean;
}

export function ProjectCard(props: ProjectCardProps) {
  return (
    <OptionalPerfProfiler id={`ProjectCard:${props.project.id.slice(0, 8)}`}>
      <ProjectCardInner {...props} />
    </OptionalPerfProfiler>
  );
}

function ProjectCardInner({ project, isSelected, onSelect, onDoubleClick, onDelete, onRename, onArchive, onRestore, compact }: ProjectCardProps) {
  const { theme } = useTheme();
  const taskCount = project.taskCount ?? project.tasks.length;
  const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
  const isMissing = !project.exists;
  const isStudio = project.projectType === "studio";

  const {
    isEditing,
    editName,
    isRenaming,
    renameError,
    inputRef,
    skipBlurSubmitRef,
    beginEditing,
    changeName,
    handleBlur,
    handleKeyDown,
  } = useProjectRename(project.name, onRename);
  const MAX_NAME_LEN = MAX_PROJECT_NAME_LEN;

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    beginEditing();
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
            <>
              <input
                ref={inputRef}
                type="text"
                value={editName}
                maxLength={MAX_NAME_LEN}
                onChange={(e) => changeName(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                disabled={isRenaming}
                onClick={(e) => e.stopPropagation()}
                className={`
                  text-sm font-semibold w-full bg-transparent
                  border-b outline-none
                  text-[var(--color-text)]
                  ${renameError ? "border-[var(--color-error)]" : "border-[var(--color-highlight)]"}
                  ${isRenaming ? "opacity-50" : ""}
                `}
              />
              {renameError && (
                <p className="text-[10px] text-[var(--color-error)] mt-0.5 truncate" title={renameError}>
                  {renameError}
                </p>
              )}
            </>
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
        {project.archived && <ProjectTypeBadge type={project.projectType} />}
        {isMissing ? (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-error)]/10 text-[var(--color-error)] border border-[var(--color-error)]/20"
            title="This project's directory no longer exists on disk"
          >
            <FolderX className="w-3 h-3" />
            Missing
          </span>
        ) : isStudio || project.isGitRepo ? (
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
        {onRestore ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
            className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/10 transition-colors"
            title="Restore project"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        ) : onArchive ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
            className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/10 transition-colors"
            title="Archive project"
          >
            <Archive className="w-4 h-4" />
          </button>
        ) : null}
        <button
          onPointerDown={() => {
            // Mark before the input loses focus so handleBlur skips
            // the submit. Without this, clicking Trash mid-edit would
            // silently rename the project to whatever was typed.
            // pointerdown covers mouse, touch, and stylus uniformly
            // and fires before the input's blur in all those input
            // modes (mousedown alone misses some touch sequences).
            if (isEditing) skipBlurSubmitRef.current = true;
          }}
          onPointerUp={() => {
            // Reset asynchronously so a still-pending blur (which
            // hasn't run yet) sees the flag, but a later legitimate
            // blur (after the user dragged off this button without
            // clicking — no blur fires now, but eventually focus
            // moves elsewhere) doesn't inherit a stale `true`.
            // rAF gives blur one tick to run if it's coming.
            requestAnimationFrame(() => {
              skipBlurSubmitRef.current = false;
            });
          }}
          onPointerCancel={() => {
            skipBlurSubmitRef.current = false;
          }}
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
