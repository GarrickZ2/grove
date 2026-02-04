import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Check, Plus, Settings2, FolderGit2 } from "lucide-react";
import { useProject } from "../../context";
import type { Project } from "../../data/types";

interface ProjectSelectorProps {
  collapsed: boolean;
  onManageProjects?: () => void;
}

export function ProjectSelector({ collapsed, onManageProjects }: ProjectSelectorProps) {
  const { selectedProject, projects, selectProject } = useProject();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectProject = (project: Project) => {
    selectProject(project);
    setIsOpen(false);
  };

  if (collapsed) {
    return (
      <div className="px-2 py-2">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setIsOpen(!isOpen)}
          title={selectedProject?.name || "Select Project"}
          className="w-full flex items-center justify-center p-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-[var(--color-highlight)] transition-colors"
        >
          <FolderGit2 className="w-5 h-5 text-[var(--color-highlight)]" />
        </motion.button>
      </div>
    );
  }

  return (
    <div className="px-3 py-2" ref={dropdownRef}>
      <motion.button
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.99 }}
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-[var(--color-highlight)] transition-colors"
      >
        <FolderGit2 className="w-4 h-4 text-[var(--color-highlight)] flex-shrink-0" />
        <span className="flex-1 text-left text-sm font-medium text-[var(--color-text)] truncate">
          {selectedProject?.name || "Select Project"}
        </span>
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
            className="absolute left-3 right-3 mt-1 z-50 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden"
          >
            {/* Project List */}
            <div className="max-h-64 overflow-y-auto">
              {projects.map((project) => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  isSelected={selectedProject?.id === project.id}
                  onClick={() => handleSelectProject(project)}
                />
              ))}
            </div>

            {/* Divider */}
            <div className="border-t border-[var(--color-border)]" />

            {/* Actions */}
            <div className="p-1">
              <button
                onClick={() => {
                  setIsOpen(false);
                  // TODO: Open add project dialog
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Add Project</span>
              </button>
              <button
                onClick={() => {
                  setIsOpen(false);
                  onManageProjects?.();
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

interface ProjectItemProps {
  project: Project;
  isSelected: boolean;
  onClick: () => void;
}

function ProjectItem({ project, isSelected, onClick }: ProjectItemProps) {
  const liveCount = project.tasks.filter((t) => t.status === "live").length;
  const totalCount = project.tasks.length;

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-start gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-secondary)] transition-colors ${
        isSelected ? "bg-[var(--color-highlight)]/5" : ""
      }`}
    >
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-text)] truncate">
            {project.name}
          </span>
          {isSelected && (
            <Check className="w-4 h-4 text-[var(--color-highlight)] flex-shrink-0" />
          )}
        </div>
        <div className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
          {project.path}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-[var(--color-text-muted)]">
            {totalCount} task{totalCount !== 1 ? "s" : ""}
          </span>
          {liveCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-[var(--color-success)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
              {liveCount} live
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
