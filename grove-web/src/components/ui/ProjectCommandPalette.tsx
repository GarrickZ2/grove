import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search } from "lucide-react";
import { useProject, useTheme } from "../../context";
import type { Project } from "../../data/types";
import { getProjectStyle } from "../../utils/projectStyle";

interface ProjectCommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectSelect?: () => void;
}

export function ProjectCommandPalette({ isOpen, onClose, onProjectSelect }: ProjectCommandPaletteProps) {
  const { selectedProject, projects, selectProject } = useProject();
  const { theme } = useTheme();
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredProjects = useMemo(() => {
    if (!searchQuery) return projects;
    const q = searchQuery.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, searchQuery]);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      setHighlightedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-palette-item]");
    const item = items[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const handleSelect = useCallback((project: Project) => {
    const switched = selectedProject?.id !== project.id;
    selectProject(project);
    onClose();
    if (switched) onProjectSelect?.();
  }, [selectedProject, selectProject, onClose, onProjectSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < filteredProjects.length - 1 ? prev + 1 : 0
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredProjects.length - 1
        );
        break;
      case "Enter":
        e.preventDefault();
        if (filteredProjects[highlightedIndex]) {
          handleSelect(filteredProjects[highlightedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }, [filteredProjects, highlightedIndex, handleSelect, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-50"
            data-hotkeys-dialog
          />
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="fixed left-1/2 top-[15%] -translate-x-1/2 z-50 w-full max-w-lg"
            onKeyDown={handleKeyDown}
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
                <Search className="w-4 h-4 text-[var(--color-text-muted)] flex-shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search projects..."
                  className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)] outline-none"
                />
                <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)] bg-[var(--color-bg)] border border-[var(--color-border)] rounded">
                  ESC
                </kbd>
              </div>

              {/* List */}
              <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
                {filteredProjects.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
                    No projects found
                  </div>
                ) : (
                  filteredProjects.map((project, index) => {
                    const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
                    const totalCount = project.taskCount ?? project.tasks.length;
                    return (
                      <button
                        key={project.id}
                        data-palette-item
                        onClick={() => handleSelect(project)}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors ${
                          index === highlightedIndex
                            ? "bg-[var(--color-highlight)]/10"
                            : "hover:bg-[var(--color-bg-tertiary)]"
                        }`}
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ backgroundColor: color.bg }}
                        >
                          <Icon className="w-4 h-4" style={{ color: color.fg }} />
                        </div>
                        <div className="flex-1 min-w-0 text-left">
                          <div className="text-sm font-medium text-[var(--color-text)] truncate">
                            {project.name}
                          </div>
                          <div className="text-xs text-[var(--color-text-muted)]">
                            {totalCount} task{totalCount !== 1 ? "s" : ""}
                          </div>
                        </div>
                        {selectedProject?.id === project.id && (
                          <span className="text-xs text-[var(--color-highlight)] flex-shrink-0">current</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">&uarr;&darr;</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">&crarr;</kbd>
                  select
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">esc</kbd>
                  close
                </span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
