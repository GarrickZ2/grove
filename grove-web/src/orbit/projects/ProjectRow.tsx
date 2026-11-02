import type { CSSProperties } from "react";
import { FolderX } from "lucide-react";
import type { Project } from "../../data/types";
import { useTheme } from "../../context";
import { getProjectStyle } from "../../utils/projectStyle";
import { kindLabel, projectHealth, taskLine } from "./projectsView";

interface ProjectRowProps {
  project: Project;
  isCurrent: boolean;
  isSelected: boolean;
  index: number;
  onSelect: () => void;
  onOpen: () => void;
}

/** Compact list row: avatar, name, Current badge, kind and task count. */
export function ProjectRow({ project, isCurrent, isSelected, index, onSelect, onOpen }: ProjectRowProps) {
  const { theme } = useTheme();
  const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
  const health = projectHealth(project);
  const style = { "--opj-c": color.fg, animationDelay: `${Math.min(index, 14) * 30 + 60}ms` } as CSSProperties;
  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-project-id={project.id}
      tabIndex={isSelected ? 0 : -1}
      className={`opj-row${isSelected ? " is-sel" : ""}${health === "missing" ? " is-missing" : ""}${project.archived ? " is-archived" : ""}`}
      style={style}
      title={project.archived ? undefined : "Double-click to open"}
      onClick={onSelect}
      onDoubleClick={() => {
        if (!project.archived) onOpen();
      }}
    >
      <span className="opj-avatar is-sm" aria-hidden="true"><Icon /></span>
      <span className="opj-row-copy">
        <span className="opj-row-name">
          <span className="oui-truncate">{project.name}</span>
          {isCurrent ? <span className="opj-badge is-current">Current</span> : null}
        </span>
        <span className="opj-row-meta">
          {health === "missing" ? (
            <span className="opj-row-warn"><FolderX aria-hidden="true" />Folder not found</span>
          ) : (
            <>
              <span>{kindLabel(project)}</span>
              <span aria-hidden="true">·</span>
              <span>{taskLine(project)}</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}
