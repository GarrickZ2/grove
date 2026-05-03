import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { Plus, FolderGit2, Sparkles, Code2 } from "lucide-react";
import { Button } from "../ui";
import { ProjectCard } from "./ProjectCard";
import { AddProjectDialog } from "./AddProjectDialog";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { useProject } from "../../context";
import { useIsMobile } from "../../hooks";
import { filterProjectsByType } from "../../utils/projectFilter";
import type { Project } from "../../data/types";
import { OptionalPerfProfiler } from "../../perf/profilerShim";

interface ProjectsPageProps {
  onNavigate?: (page: string) => void;
  initialTab?: "coding" | "studio";
}

export function ProjectsPage({ onNavigate, initialTab }: ProjectsPageProps) {
  const { projects, selectedProject, selectProject, addProject, createNewProject, deleteProject, refreshProjects } = useProject();
  const { isMobile } = useIsMobile();
  const codingProjects = useMemo(() => filterProjectsByType(projects, "coding"), [projects]);
  const studioProjects = useMemo(() => filterProjectsByType(projects, "studio"), [projects]);
  const [activeTab, setActiveTab] = useState<"studio" | "coding">(
    initialTab ?? (selectedProject?.projectType === "studio" ? "studio" : "coding"),
  );
  const [addDialogMode, setAddDialogMode] = useState<"coding" | "studio">(
    selectedProject?.projectType === "studio" ? "studio" : "coding",
  );

  // Refresh project list when navigating to this page
  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!selectedProject || initialTab !== undefined) return;
    setActiveTab(selectedProject.projectType === "studio" ? "studio" : "coding");
  }, [selectedProject, initialTab]);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openAddDialog = (mode: "coding" | "studio") => {
    setAddDialogMode(mode);
    setShowAddDialog(true);
    setError(null);
  };

  const handleAddProject = async (path: string, name?: string) => {
    try {
      setIsAdding(true);
      setError(null);
      const project = await addProject(path, name);
      selectProject(project);
      setShowAddDialog(false);
    } catch (err: unknown) {
      console.error("Failed to add project:", err);
      if (err && typeof err === "object" && "message" in err) {
        // Backend returns specific error messages in the body; prefer them.
        const apiErr = err as { status?: number; message: string };
        setError(apiErr.message || "Failed to add project");
      } else {
        setError("Failed to add project");
      }
    } finally {
      setIsAdding(false);
    }
  };

  const handleCreateNewProject = async (parentDir: string, name: string, initGit: boolean, projectType?: string) => {
    try {
      setIsAdding(true);
      setError(null);
      const project = await createNewProject(parentDir, name, initGit, projectType);
      selectProject(project);
      setShowAddDialog(false);
    } catch (err: unknown) {
      console.error("Failed to create project:", err);
      if (err && typeof err === "object" && "message" in err) {
        setError((err as { message: string }).message || "Failed to create project");
      } else {
        setError("Failed to create project");
      }
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteProject = async () => {
    if (projectToDelete) {
      try {
        setIsDeleting(true);
        setError(null);
        await deleteProject(projectToDelete.id);
        setProjectToDelete(null);
      } catch (err) {
        console.error("Failed to delete project:", err);
        setError("Failed to delete project");
      } finally {
        setIsDeleting(false);
      }
    }
  };

  const handleSelectProject = (project: Project) => {
    selectProject(project);
  };

  const handleDoubleClick = (project: Project) => {
    selectProject(project);
    onNavigate?.("dashboard");
  };

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
            isSelected={selectedProject?.id === project.id}
            onSelect={() => handleSelectProject(project)}
            onDoubleClick={() => handleDoubleClick(project)}
            onDelete={() => setProjectToDelete(project)}
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
      items: codingProjects,
      icon: Code2,
      includeAddCard: true,
    },
    studio: {
      label: "Studio Projects",
      items: studioProjects,
      icon: Sparkles,
      includeAddCard: true,
    },
  } as const;

  const currentTab = tabMeta[activeTab];

  return (
    <OptionalPerfProfiler id="ProjectsPage">
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-full"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="inline-flex rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-1">
          {(Object.entries(tabMeta) as Array<[keyof typeof tabMeta, typeof tabMeta[keyof typeof tabMeta]]>).map(([key, tab]) => {
            const Icon = tab.icon;
            const isActive = activeTab === key;
            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-[var(--color-highlight)] text-white shadow-sm"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${isActive ? "bg-white/15 text-white" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>
                  {tab.items.length}
                </span>
              </button>
            );
          })}
        </div>
        {!isMobile && (
          <Button onClick={() => openAddDialog(activeTab)} size="sm">
            <Plus className="w-4 h-4 mr-1.5" />
            Add Project
          </Button>
        )}
      </div>

      {/* Projects Grid */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <FolderGit2 className="w-12 h-12 text-[var(--color-text-muted)] mb-4" />
          <p className="text-[var(--color-text-muted)] mb-4">No projects yet</p>
          <Button onClick={() => openAddDialog(activeTab)}>
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
            {renderProjectGrid(currentTab.items, activeTab, currentTab.includeAddCard)}
          </section>
        </div>
      )}

      {/* Dialogs */}
      <AddProjectDialog
        isOpen={showAddDialog}
        onClose={() => {
          setShowAddDialog(false);
          setError(null);
        }}
        onAdd={handleAddProject}
        onCreateNew={handleCreateNewProject}
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
