import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { Plus, FolderGit2, Sparkles, Code2, Archive } from "lucide-react";
import { Button } from "../ui";
import { ProjectCard } from "./ProjectCard";
import { AddProjectDialog } from "./AddProjectDialog";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { useProject } from "../../context";
import { useIsMobile } from "../../hooks";
import { filterProjectsByType } from "../../utils/projectFilter";
import type { Project } from "../../data/types";
import { OptionalPerfProfiler } from "../../perf/profilerShim";
import { useProjectsActions } from "./useProjectsActions";

interface ProjectsPageProps {
  onNavigate?: (page: string) => void;
  initialTab?: "coding" | "studio";
}

export function ProjectsPage({ onNavigate, initialTab }: ProjectsPageProps) {
  const { projects, selectedProject } = useProject();
  const { isMobile } = useIsMobile();
  const codingProjects = useMemo(() => filterProjectsByType(projects, "coding"), [projects]);
  const studioProjects = useMemo(() => filterProjectsByType(projects, "studio"), [projects]);
  const [activeTab, setActiveTab] = useState<"studio" | "coding" | "archived">(
    initialTab ?? (selectedProject?.projectType === "studio" ? "studio" : "coding"),
  );
  const {
    archivedProjects,
    projectActionId,
    addDialogMode,
    showAddDialog,
    projectToDelete,
    setProjectToDelete,
    isAdding,
    isDeleting,
    error,
    openAddDialog,
    closeAddDialog,
    handleAddProject,
    handleCloneProject,
    handleCreateNewProject,
    handleDeleteProject,
    handleSelectProject,
    handleOpenProject: handleDoubleClick,
    handleRenameProject,
    handleArchiveProject,
    handleRestoreProject,
  } = useProjectsActions(onNavigate);

  // Sync activeTab to selectedProject.projectType. Use a "previous selected
  // project" tracker computed during render instead of useEffect to satisfy
  // react-hooks/set-state-in-effect. When `initialTab` is provided the parent
  // is driving the tab, so the auto-sync stays disabled.
  const [prevSelectedId, setPrevSelectedId] = useState(selectedProject?.id ?? null);
  const currentSelectedId = selectedProject?.id ?? null;
  if (currentSelectedId !== prevSelectedId) {
    setPrevSelectedId(currentSelectedId);
    if (selectedProject && initialTab === undefined) {
      setActiveTab(selectedProject.projectType === "studio" ? "studio" : "coding");
    }
  }

  const renderProjectGrid = (items: Project[], sectionKey: string, includeAddCard = false) => (
    <div className={`grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 ${isMobile ? "gap-2" : "gap-4"}`}>
      {items.map((project, index) => (
        <motion.div
          key={project.id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.04 }}
        >
          <ProjectCard
            project={project}
            isSelected={!project.archived && selectedProject?.id === project.id}
            onSelect={() => {
              if (!project.archived) handleSelectProject(project);
            }}
            onDoubleClick={project.archived ? undefined : () => handleDoubleClick(project)}
            onDelete={() => setProjectToDelete(project)}
            onRename={(newName) => handleRenameProject(project, newName)}
            onArchive={project.archived || projectActionId === project.id ? undefined : () => void handleArchiveProject(project)}
            onRestore={!project.archived || projectActionId === project.id ? undefined : () => void handleRestoreProject(project)}
            compact={isMobile}
          />
        </motion.div>
      ))}

      {includeAddCard && !isMobile && (
        <motion.div
          key={`${sectionKey}-add`}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: items.length * 0.04 }}
          className="h-full"
        >
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => openAddDialog(sectionKey === "studio" ? "studio" : "coding")}
            className="w-full h-full p-4 rounded-xl border-2 border-dashed border-[var(--color-border)] hover:border-[var(--color-highlight)] bg-transparent hover:bg-[var(--color-bg-secondary)] transition-colors flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5 text-[var(--color-text-muted)]" />
            <span className="text-sm text-[var(--color-text-muted)]">Add Project</span>
          </motion.button>
        </motion.div>
      )}
    </div>
  );

  const tabMeta = {
    coding: {
      label: "Coding Projects",
      mobileLabel: "Coding",
      items: codingProjects,
      icon: Code2,
      includeAddCard: true,
    },
    studio: {
      label: "Studio Projects",
      mobileLabel: "Studio",
      items: studioProjects,
      icon: Sparkles,
      includeAddCard: true,
    },
    archived: {
      label: "Archived Projects",
      mobileLabel: "Archived",
      items: archivedProjects,
      icon: Archive,
      includeAddCard: false,
    },
  } as const;

  const currentTab = tabMeta[activeTab];
  const visibleTabs = isMobile
    ? (["coding", "studio", "archived"] as const)
    : (["coding", "studio"] as const);

  return (
    <OptionalPerfProfiler id="ProjectsPage">
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="min-h-full lg:h-full lg:overflow-y-auto pl-1 pr-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className={`${isMobile ? "grid w-full min-w-0 grid-cols-3" : "inline-flex"} rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-1`}>
          {visibleTabs.map((key) => {
            const tab = tabMeta[key];
            const Icon = tab.icon;
            const isActive = activeTab === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={isActive}
                onClick={() => setActiveTab(key)}
                className={`inline-flex items-center rounded-xl font-medium transition-colors ${
                  isMobile
                    ? "min-h-11 min-w-0 justify-center gap-1 whitespace-nowrap px-1 py-2 text-xs"
                    : "gap-2 px-4 py-2 text-sm"
                } ${
                  isActive
                    ? "bg-[var(--color-highlight)] text-white shadow-sm"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {!isMobile && <Icon className="w-4 h-4" />}
                <span>{isMobile ? tab.mobileLabel : tab.label}</span>
                {(key !== "archived" || tab.items.length > 0) && (
                  <span className={`shrink-0 rounded-full py-0.5 ${isMobile ? "px-1 text-[10px]" : "px-2 text-[11px]"} ${isActive ? "bg-white/15 text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>
                    {tab.items.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {!isMobile && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab("archived")}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === "archived"
                  ? "border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                  : "border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              <Archive className="w-3.5 h-3.5" />
              <span>Archived</span>
              {archivedProjects.length > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                  activeTab === "archived"
                    ? "bg-[var(--color-highlight)]/15 text-[var(--color-highlight)]"
                    : "text-[var(--color-text-muted)]"
                }`}>
                  {archivedProjects.length}
                </span>
              )}
            </button>
            <Button
              onClick={() => openAddDialog(
                activeTab === "archived"
                  ? (selectedProject?.projectType === "studio" ? "studio" : "coding")
                  : activeTab
              )}
              size="sm"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Add Project
            </Button>
          </div>
        )}
      </div>

      {error && !showAddDialog && (
        <div className="mb-4 rounded-lg border border-[var(--color-error)]/20 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {error}
        </div>
      )}

      {/* Projects Grid */}
      {activeTab !== "archived" && projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <FolderGit2 className="w-12 h-12 text-[var(--color-text-muted)] mb-4" />
          <p className="text-[var(--color-text-muted)] mb-4">No projects yet</p>
          <Button onClick={() => openAddDialog(activeTab === "studio" ? "studio" : "coding")}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add Your First Project
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <section className="space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div className="text-base font-semibold text-[var(--color-text)]">{currentTab.label}</div>
              <div className="text-xs text-[var(--color-text-muted)] shrink-0">
                {currentTab.items.length} {currentTab.items.length === 1 ? "project" : "projects"}
              </div>
            </div>
            {currentTab.items.length === 0 && activeTab === "archived" ? (
              <div className="flex flex-col items-center justify-center py-16 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                <Archive className="w-12 h-12 text-[var(--color-text-muted)] mb-4" />
                <p className="text-[var(--color-text-muted)]">No archived projects</p>
              </div>
            ) : (
              renderProjectGrid(currentTab.items, activeTab, currentTab.includeAddCard)
            )}
          </section>
        </div>
      )}

      {/* Dialogs */}
      <AddProjectDialog
        isOpen={showAddDialog}
        onClose={closeAddDialog}
        onAdd={handleAddProject}
        onCreateNew={handleCreateNewProject}
        onClone={handleCloneProject}
        isLoading={isAdding}
        externalError={error}
        initialMode={addDialogMode}
      />

      <DeleteProjectDialog
        isOpen={projectToDelete !== null}
        project={projectToDelete}
        onClose={() => setProjectToDelete(null)}
        onConfirm={handleDeleteProject}
        isLoading={isDeleting}
      />
    </motion.div>
    </OptionalPerfProfiler>
  );
}
