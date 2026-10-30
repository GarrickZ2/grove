import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Check, ChevronsUpDown, FolderX, Plus, Search, Settings2 } from "lucide-react";
import { useTheme } from "../../context";
import { getProjectStyle } from "../../utils/projectStyle";
import { MiddleTruncatedText } from "./ProjectSelector";
import { useProjectSelector, type ProjectTypeFilter } from "./useProjectSelector";

interface OrbitProjectSelectorProps {
  onManageProjects?: (tab?: ProjectTypeFilter) => void;
  onAddProject?: (studioMode?: "studio") => void;
  onProjectSwitch?: (projectId?: string) => void;
}

const optionId = (projectId: string) => `orbit-project-option-${projectId}`;
const typeTabs: { id: ProjectTypeFilter; label: string }[] = [{ id: "coding", label: "Coding" }, { id: "studio", label: "Studio" }];

/** Orbit's project switcher: a sidebar row that opens a menu sized to the sidebar. */
export function OrbitProjectSelector({ onManageProjects, onAddProject, onProjectSwitch }: OrbitProjectSelectorProps) {
  const { theme } = useTheme();
  const {
    selectedProject, filteredProjects, isOpen, setIsOpen, closeDropdown, searchQuery, setSearchQuery,
    typeFilter, setTypeFilter, activeProjectId, setActiveProjectId, dropdownRef, searchInputRef, itemRefs,
    handleSelectProject, handleSearchKeyDown,
  } = useProjectSelector(onProjectSwitch);
  const selectedStyle = selectedProject ? getProjectStyle(selectedProject.id, theme.accentPalette) : null;
  const SelectedIcon = selectedStyle?.Icon;

  return (
    <div className="orbit-project-selector" ref={dropdownRef}>
      <button type="button" className={`orbit-row orbit-project-trigger${isOpen ? " is-open" : ""}`} aria-haspopup="listbox" aria-expanded={isOpen} title={selectedProject?.name} onClick={() => (isOpen ? closeDropdown() : setIsOpen(true))}>
        <span className="orbit-project-icon" style={selectedStyle ? { backgroundColor: selectedStyle.color.bg } : undefined}>{SelectedIcon && <SelectedIcon size={12} style={{ color: selectedStyle.color.fg }} />}</span>
        <MiddleTruncatedText text={selectedProject?.name || "Select Project"} className="orbit-project-name" />
        <ChevronsUpDown size={14} className="orbit-project-chevron" />
      </button>
      <AnimatePresence>
        {isOpen && <motion.div className="orbit-project-menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.12 }}>
          <div className="orbit-project-search">
            <Search size={14} />
            <input ref={searchInputRef} type="text" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={handleSearchKeyDown} role="combobox" aria-expanded={isOpen} aria-controls="orbit-project-listbox" aria-activedescendant={activeProjectId ? optionId(activeProjectId) : undefined} aria-autocomplete="list" placeholder="Filter projects..." />
          </div>
          <div className="orbit-project-tabs" role="tablist" aria-label="Project type">
            {typeTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={typeFilter === tab.id} className={typeFilter === tab.id ? "is-selected" : ""} onClick={() => setTypeFilter(tab.id)}>{tab.label}</button>)}
          </div>
          <div id="orbit-project-listbox" className="orbit-project-list" role="listbox" aria-label="Projects">
            {filteredProjects.map((project) => {
              const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
              const isSelected = selectedProject?.id === project.id;
              const isMissing = !project.exists;
              const notInitialized = !isMissing && project.projectType !== "studio" && !project.isGitRepo;
              return <button key={project.id} id={optionId(project.id)} ref={(node) => { itemRefs.current[project.id] = node; }} type="button" role="option" aria-selected={activeProjectId === project.id} title={isMissing ? `${project.name} (directory missing)` : project.name}
                className={`orbit-project-option${activeProjectId === project.id ? " is-active" : ""}${isSelected ? " is-selected" : ""}${isMissing ? " is-missing" : ""}`}
                onClick={() => handleSelectProject(project)} onMouseEnter={() => setActiveProjectId(project.id)}>
                <span className="orbit-project-icon" style={{ backgroundColor: color.bg }}><Icon size={12} style={{ color: color.fg }} /></span>
                <MiddleTruncatedText text={project.name} className="orbit-project-name" />
                {isMissing ? <span className="orbit-project-flag is-error" title="Directory no longer exists on disk"><FolderX size={13} /></span>
                  : notInitialized ? <span className="orbit-project-flag is-warning" title="Not a Git repository yet"><AlertCircle size={13} /></span>
                    : null}
                <span className="orbit-project-check">{isSelected && <Check size={14} />}</span>
              </button>;
            })}
            {filteredProjects.length === 0 && <p className="orbit-project-empty">No projects</p>}
          </div>
          <div className="orbit-menu-divider" />
          <button type="button" className="orbit-project-action" onClick={() => { closeDropdown(); onAddProject?.(typeFilter === "studio" ? "studio" : undefined); }}><Plus size={15} /><span>Add Project</span></button>
          <button type="button" className="orbit-project-action" onClick={() => { closeDropdown(); onManageProjects?.(typeFilter); }}><Settings2 size={15} /><span>Manage Projects</span></button>
        </motion.div>}
      </AnimatePresence>
    </div>
  );
}
