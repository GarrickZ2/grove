import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Check, Plus, Settings2, Search, AlertCircle, FolderX, Sparkles } from "lucide-react";
import { useProject, useTheme } from "../../context";
import type { Project } from "../../data/types";
import { getProjectStyle } from "../../utils/projectStyle";
import { filterProjectsByType } from "../../utils/projectFilter";

interface ProjectSelectorProps {
  collapsed: boolean;
  onManageProjects?: (tab?: "coding" | "studio") => void;
  onAddProject?: (studioMode?: "studio") => void;
  onProjectSwitch?: () => void;
}

function TypeFilterTabs({ active, onChange }: { active: "coding" | "studio"; onChange: (tab: "coding" | "studio") => void }) {
  return (
    <div className="relative flex border-b border-[var(--color-border)]">
      <button
        type="button"
        onClick={() => onChange("coding")}
        className={`flex-1 px-3 py-2 text-xs font-medium transition-colors z-10 ${
          active === "coding"
            ? "text-[var(--color-highlight)]"
            : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        }`}
      >
        Coding
      </button>
      <button
        type="button"
        onClick={() => onChange("studio")}
        className={`flex-1 px-3 py-2 text-xs font-medium transition-colors z-10 ${
          active === "studio"
            ? "text-[var(--color-highlight)]"
            : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        }`}
      >
        Studio
      </button>
      <motion.div
        className="absolute bottom-0 left-0 w-1/2 h-[2px] bg-[var(--color-highlight)]"
        animate={{ left: active === "studio" ? "50%" : "0%" }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
    </div>
  );
}

export function ProjectSelector({ collapsed, onManageProjects, onAddProject, onProjectSwitch }: ProjectSelectorProps) {
  const { selectedProject, projects, selectProject, refreshProjects } = useProject();
  const { theme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"coding" | "studio">(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("projectSelectorTab");
    } catch {
      return "coding";
    }
    if (stored === "coding" || stored === "studio") return stored;
    return "coding";
  });

  const handleSetTypeFilter = (tab: "coding" | "studio") => {
    setTypeFilter(tab);
    try {
      localStorage.setItem("projectSelectorTab", tab);
    } catch {
      // Ignore storage errors (private browsing, quota exceeded)
    }
  };
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const filteredProjects = useMemo(() => {
    let list = projects;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    if (typeFilter === "studio") {
      list = filterProjectsByType(list, "studio");
    } else {
      list = filterProjectsByType(list, "coding");
    }
    return list;
  }, [projects, searchQuery, typeFilter]);

  // Derive activeProjectId from filteredProjects without setState-in-effect
  const derivedActiveProjectId = useMemo(() => {
    if (!isOpen || filteredProjects.length === 0) return null;
    if (activeProjectId && filteredProjects.some((p) => p.id === activeProjectId)) {
      return activeProjectId;
    }
    return filteredProjects[0].id;
  }, [filteredProjects, isOpen, activeProjectId]);

  const activeProjectOptionId = derivedActiveProjectId ? `project-selector-option-${derivedActiveProjectId}` : undefined;

  useEffect(() => {
    if (!derivedActiveProjectId || !isOpen) return;

    itemRefs.current[derivedActiveProjectId]?.scrollIntoView({
      block: "nearest",
    });
  }, [derivedActiveProjectId, isOpen]);

  // Helper to close dropdown and reset search
  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    setSearchQuery("");
    setActiveProjectId(null);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        closeDropdown();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeDropdown]);

  // Auto-focus search input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // Refresh project list each time the dropdown opens so newly registered or
  // renamed projects show up without a full page reload.
  useEffect(() => {
    if (!isOpen) return;
    void refreshProjects();
  }, [isOpen, refreshProjects]);

  const handleSelectProject = (project: Project) => {
    const switched = selectedProject?.id !== project.id;
    selectProject(project);
    closeDropdown();
    if (switched) onProjectSwitch?.();
  };

  const moveActiveProject = (direction: 1 | -1) => {
    if (filteredProjects.length === 0) return;

    const currentIndex = filteredProjects.findIndex((project) => project.id === derivedActiveProjectId);
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (startIndex + direction + filteredProjects.length) % filteredProjects.length;
    setActiveProjectId(filteredProjects[nextIndex].id);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActiveProject(1);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActiveProject(-1);
      return;
    }

    if (e.key === "Enter") {
      if (!derivedActiveProjectId) return;

      const activeProject = filteredProjects.find((project) => project.id === derivedActiveProjectId);
      if (!activeProject) return;

      e.preventDefault();
      handleSelectProject(activeProject);
      return;
    }

    if (e.key === "Escape") {
      if (searchQuery) {
        setSearchQuery("");
      } else {
        closeDropdown();
      }
      e.stopPropagation();
    }
  };

  if (collapsed) {
    const style = selectedProject ? getProjectStyle(selectedProject.id, theme.accentPalette) : null;
    const Icon = style?.Icon;
    return (
      <div className="px-2 py-2 relative select-none" ref={dropdownRef}>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setIsOpen(!isOpen)}
          title={selectedProject?.name || "Select Project"}
          className="w-full flex items-center justify-center p-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-highlight)] transition-colors"
          style={style ? { backgroundColor: style.color.bg } : { backgroundColor: "var(--color-bg-secondary)" }}
        >
          {Icon ? (
            <Icon className="w-5 h-5" style={{ color: style?.color.fg }} />
          ) : (
            <div className="w-5 h-5" />
          )}
        </motion.button>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.15 }}
              className="absolute left-full top-0 ml-2 z-50 w-72 max-w-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden"
            >
              {/* Search Input */}
              <div className="p-2 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--color-bg-secondary)]">
                  <Search className="w-3.5 h-3.5 text-[var(--color-text-muted)] flex-shrink-0" />
                  <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  role="combobox"
                  aria-expanded={isOpen}
                  aria-controls="project-selector-listbox-collapsed"
                  aria-activedescendant={activeProjectOptionId}
                  aria-autocomplete="list"
                  placeholder="Filter projects..."
                  className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)] outline-none min-w-0"
                />
              </div>
              </div>
              <TypeFilterTabs active={typeFilter} onChange={handleSetTypeFilter} />
              <div
                id="project-selector-listbox-collapsed"
                role="listbox"
                aria-label="Projects"
                className="max-h-64 overflow-y-auto"
              >
                {filteredProjects.map((project) => (
                  <ProjectItem
                    key={project.id}
                    ref={(node) => {
                      itemRefs.current[project.id] = node;
                    }}
                    project={project}
                    isSelected={selectedProject?.id === project.id}
                    isActive={derivedActiveProjectId === project.id}
                    onClick={() => handleSelectProject(project)}
                    onMouseEnter={() => setActiveProjectId(project.id)}
                    accentPalette={theme.accentPalette}
                  />
                ))}
              </div>
              <div className="p-1">
                <button
                  onClick={() => { closeDropdown(); onAddProject?.(typeFilter === "studio" ? "studio" : undefined); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Project</span>
                </button>
                <button
                  onClick={() => { closeDropdown(); onManageProjects?.(typeFilter); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
                >
                  <Settings2 className="w-4 h-4" />
                  <span>Manage Projects</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  const selectedStyle = selectedProject ? getProjectStyle(selectedProject.id, theme.accentPalette) : null;
  const SelectedIcon = selectedStyle?.Icon;

  return (
    <div className="px-3 py-2 select-none" ref={dropdownRef}>
      <motion.button
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.99 }}
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-[var(--color-highlight)] transition-colors"
      >
        {selectedStyle && SelectedIcon ? (
          <div
            className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: selectedStyle.color.bg }}
          >
            <SelectedIcon className="w-3.5 h-3.5" style={{ color: selectedStyle.color.fg }} />
          </div>
        ) : (
          <div className="w-6 h-6 rounded bg-[var(--color-bg-tertiary)] flex-shrink-0" />
        )}
        <MiddleTruncatedText
          text={selectedProject?.name || "Select Project"}
          className="flex-1 text-left text-sm font-medium text-[var(--color-text)]"
        />
        <ChevronDown
          className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className="absolute left-3 mt-1 z-50 w-72 max-w-sm min-w-[calc(100%-1.5rem)] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden"
          >
            {/* Search Input */}
            <div className="p-2 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--color-bg-secondary)]">
                <Search className="w-3.5 h-3.5 text-[var(--color-text-muted)] flex-shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  role="combobox"
                  aria-expanded={isOpen}
                  aria-controls="project-selector-listbox"
                  aria-activedescendant={activeProjectOptionId}
                  aria-autocomplete="list"
                  placeholder="Filter projects..."
                  className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)] outline-none min-w-0"
                />
              </div>
            </div>
            <TypeFilterTabs active={typeFilter} onChange={handleSetTypeFilter} />
            <div
              id="project-selector-listbox"
              role="listbox"
              aria-label="Projects"
              className="max-h-64 overflow-y-auto"
            >
              {filteredProjects.map((project) => (
                <ProjectItem
                  key={project.id}
                  ref={(node) => {
                    itemRefs.current[project.id] = node;
                  }}
                  project={project}
                  isSelected={selectedProject?.id === project.id}
                  isActive={derivedActiveProjectId === project.id}
                  onClick={() => handleSelectProject(project)}
                  onMouseEnter={() => setActiveProjectId(project.id)}
                  accentPalette={theme.accentPalette}
                />
              ))}
            </div>
            <div className="border-t border-[var(--color-border)]" />

            {/* Actions */}
            <div className="p-1">
              <button
                onClick={() => {
                  closeDropdown();
                  onAddProject?.(typeFilter === "studio" ? "studio" : undefined);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Add Project</span>
              </button>
              <button
                onClick={() => {
                  closeDropdown();
                  onManageProjects?.(typeFilter);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
              >
                <Settings2 className="w-4 h-4" />
                <span>Manage Projects</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Split text into two halves for middle truncation.
 *  When the container overflows, the first half gets "..." while the second half stays visible.
 *  e.g. `open_solution_video_sync` → `open_solu...video_sync` */
function MiddleTruncatedText({ text, className }: { text: string; className?: string }) {
  const { firstHalf, secondHalf } = useMemo(() => {
    if (text.length <= 8) return { firstHalf: text, secondHalf: "" };

    const mid = Math.ceil(text.length * 0.5);
    const range = Math.ceil(text.length * 0.2);
    const separators = new Set(["_", "-", "/", ".", " "]);

    let best = mid;
    let bestDist = range + 1;

    for (let i = Math.max(1, mid - range); i <= Math.min(text.length - 2, mid + range); i++) {
      if (separators.has(text[i])) {
        const splitAt = i + 1; // split right after the separator
        const dist = Math.abs(splitAt - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = splitAt;
        }
      }
    }

    return { firstHalf: text.slice(0, best), secondHalf: text.slice(best) };
  }, [text]);

  if (!secondHalf) {
    return <span className={`truncate ${className ?? ""}`}>{text}</span>;
  }

  return (
    <span className={`flex overflow-hidden min-w-0 ${className ?? ""}`} title={text}>
      <span className="truncate">{firstHalf}</span>
      <span className="flex-shrink-0">{secondHalf}</span>
    </span>
  );
}

interface ProjectItemProps {
  project: Project;
  isSelected: boolean;
  isActive: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  accentPalette: string[];
}

const ProjectItem = React.forwardRef<HTMLButtonElement, ProjectItemProps>(function ProjectItem(
  { project, isSelected, isActive, onClick, onMouseEnter, accentPalette },
  ref
) {
  // Use taskCount from list API, or calculate from tasks array if full project loaded
  const totalCount = project.taskCount ?? project.tasks.length;
  const { color, Icon } = getProjectStyle(project.id, accentPalette);

  const isMissing = !project.exists;
  const isStudio = project.projectType === "studio";
  return (
    <button
      id={`project-selector-option-${project.id}`}
      ref={ref}
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      role="option"
      aria-selected={isActive}
      title={isMissing ? `${project.name} (directory missing)` : project.name}
      className={`w-full flex items-start gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-secondary)] transition-colors select-none ${
        isMissing ? "opacity-50" : ""
      } ${
        isActive
          ? "bg-[var(--color-highlight)]/10 ring-1 ring-inset ring-[var(--color-highlight)]/40"
          : isSelected
            ? "bg-[var(--color-highlight)]/5"
            : ""
      }`}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ backgroundColor: color.bg }}
      >
        <Icon className="w-4 h-4" style={{ color: color.fg }} />
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2">
          <MiddleTruncatedText
            text={project.name}
            className={`text-sm font-medium text-[var(--color-text)] ${isMissing ? "line-through" : ""}`}
          />
          {isSelected && (
            <Check className="w-4 h-4 text-[var(--color-highlight)] flex-shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {isMissing ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-[var(--color-error)]"
              title="Directory no longer exists on disk"
            >
              <FolderX className="w-3 h-3" />
              Missing
            </span>
          ) : isStudio ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-highlight)]">
              <Sparkles className="w-3 h-3" />
              Studio
            </span>
          ) : project.isGitRepo ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              {totalCount} task{totalCount !== 1 ? "s" : ""}
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-[var(--color-warning)]"
              title="Not a Git repository yet"
            >
              <AlertCircle className="w-3 h-3" />
              Not initialized
            </span>
          )}
        </div>
      </div>
    </button>
  );
});
