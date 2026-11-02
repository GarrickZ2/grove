import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, Archive, ChevronLeft, Download, FolderOpen, FolderPlus, LayoutGrid, Plus, SearchX, Sparkles, X } from "lucide-react";
import { useProject } from "../../context";
import { AddProjectDialog } from "../../components/Projects/AddProjectDialog";
import { DeleteProjectDialog } from "../../components/Projects/DeleteProjectDialog";
import { useProjectsActions } from "../../components/Projects/useProjectsActions";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Button, EmptyState, OrbitPage, OrbitPageHeader, PopoverMenu, SearchField, Segmented, useNow, type MenuItem, type PageHue } from "../ui";
import { ProjectRow } from "./ProjectRow";
import { ProjectDetail } from "./ProjectDetail";
import { matchProjects, projectsInTab, projectsSummary, tabCounts, type ProjectsTab } from "./projectsView";
import "../studio/orbit-studio.css";
import "./orbit-projects.css";

const HUE: PageHue = {
  from: "#5eead4",
  to: "#0f766e",
  strong: "rgba(15,118,110,.75)",
  glow: "color-mix(in oklab, #14b8a6 13%, transparent)",
};

interface OrbitProjectsPageProps {
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
  initialTab?: "coding" | "studio";
}

export function OrbitProjectsPage({ onNavigate, initialTab }: OrbitProjectsPageProps) {
  const { projects, selectedProject } = useProject();
  const actions = useProjectsActions(onNavigate);
  const { archivedProjects, openAddDialog } = actions;
  const [tab, setTab] = useState<ProjectsTab>(initialTab ?? "all");
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  // A phone shows the list, then the picked project on its own with Back.
  const { isMobile, isTablet } = useIsMobile();
  const phone = isMobile && !isTablet;
  const [phoneDetail, setPhoneDetail] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const now = useNow(60_000);

  const counts = tabCounts(projects, archivedProjects);
  const inTab = useMemo(() => projectsInTab(tab, projects, archivedProjects), [tab, projects, archivedProjects]);
  const visible = useMemo(() => matchProjects(inTab, query), [inTab, query]);
  const searching = query.trim().length > 0;
  // Highlighted in the list and shown in the detail; defaults to the active project. Never switches it.
  const selected = visible.find((project) => project.id === pickedId)
    ?? visible.find((project) => !project.archived && project.id === selectedProject?.id)
    ?? visible[0]
    ?? null;

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = selected ? visible.indexOf(selected) : -1;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    setPickedId(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(next.id)}"]`)?.focus();
  };
  const addMode = tab === "studio" ? "studio" : "coding";

  const addItems: MenuItem[] = [
    { id: "folder", icon: FolderOpen, title: "Open a folder", description: "A Git repo already on this machine", onSelect: () => openAddDialog("coding", "existing") },
    { id: "clone", icon: Download, title: "Clone a repository", description: "From a Git URL", onSelect: () => openAddDialog("coding", "git") },
    { id: "new", icon: FolderPlus, title: "New coding project", description: "Create a folder, optionally with Git", onSelect: () => openAddDialog("coding", "new") },
    { id: "studio", icon: Sparkles, title: "New Studio project", description: "For design, docs and assets — no Git needed", onSelect: () => openAddDialog("studio") },
  ];

  const tabOptions = [
    { value: "all" as const, label: "All", count: counts.all },
    { value: "coding" as const, label: "Coding", count: counts.coding },
    { value: "studio" as const, label: "Studio", count: counts.studio },
    { value: "archived" as const, label: "Archived", count: counts.archived },
  ];

  const empty = (() => {
    if (searching && inTab.length > 0) {
      return (
        <EmptyState icon={SearchX} title={`No projects match “${query.trim()}”`} action={<Button size="sm" onClick={() => setQuery("")}>Clear search</Button>}>
          Search looks at project names and paths.
        </EmptyState>
      );
    }
    if (tab === "archived") {
      return (
        <EmptyState icon={Archive} size="lg" title="No archived projects">
          Archive a project from its ⋯ menu to hide it here without losing its tasks or history.
        </EmptyState>
      );
    }
    if (projects.length === 0) {
      return (
        <EmptyState
          icon={LayoutGrid}
          tone="hue"
          size="lg"
          title="No projects yet"
          action={(
            <>
              <Button variant="primary" onClick={() => openAddDialog("coding", "existing")}><FolderOpen />Open a folder</Button>
              <Button onClick={() => openAddDialog("studio")}><Sparkles />New Studio project</Button>
            </>
          )}
        >
          Add a Git repo for coding agents, or start a Studio for design, docs and assets.
        </EmptyState>
      );
    }
    return (
      <EmptyState
        icon={tab === "studio" ? Sparkles : FolderOpen}
        size="lg"
        title={tab === "studio" ? "No Studio projects" : "No coding projects"}
        action={<Button variant="primary" onClick={() => openAddDialog(addMode)}><Plus />{tab === "studio" ? "New Studio project" : "Add a project"}</Button>}
      >
        {tab === "studio" ? "Studios hold design, docs and assets for agents — no Git needed." : "Add a Git repo so agents can work on it in their own worktrees."}
      </EmptyState>
    );
  })();

  const overlays = (
    <>
      <AddProjectDialog
        isOpen={actions.showAddDialog}
        onClose={actions.closeAddDialog}
        onAdd={actions.handleAddProject}
        onCreateNew={actions.handleCreateNewProject}
        onClone={actions.handleCloneProject}
        isLoading={actions.isAdding}
        externalError={actions.error}
        initialMode={actions.addDialogMode}
        initialCodingTab={actions.addCodingTab}
      />
      <DeleteProjectDialog
        isOpen={actions.projectToDelete !== null}
        project={actions.projectToDelete}
        onClose={() => actions.setProjectToDelete(null)}
        onConfirm={actions.handleDeleteProject}
        isLoading={actions.isDeleting}
      />
    </>
  );

  return (
    <OrbitPage className="opj" hue={HUE} overlays={overlays}>
      <OrbitPageHeader
        icon={LayoutGrid}
        title="Projects"
        subtitle={projectsSummary(projects, archivedProjects)}
        raised
        actions={(
          <>
            <SearchField className="opj-search" value={query} onChange={setQuery} label="Search projects" onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
            <Segmented ariaLabel="Project type" value={tab} options={tabOptions} onChange={setTab} />
            <PopoverMenu
              label="Add project"
              items={addItems}
              trigger={({ open, toggle }) => (
                <Button variant="primary" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Plus />Add project</Button>
              )}
            />
          </>
        )}
      />

      {actions.error && !actions.showAddDialog ? (
        <div className="opj-error oui-rise" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{actions.error}</span>
          <Button variant="ghost" size="sm" iconOnly aria-label="Dismiss" onClick={() => actions.setError(null)}><X /></Button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div key={`empty-${tab}`} className="opj-empty oui-rise" style={{ animationDelay: "60ms" }}>{empty}</div>
      ) : (
        <div className={`opj-body${phone ? (phoneDetail && selected ? " is-phone-detail" : " is-phone-list") : ""}`}>
          {phone && phoneDetail && selected ? (
            <div className="opj-phone-back">
              <Button variant="ghost" size="sm" onClick={() => setPhoneDetail(false)}><ChevronLeft />Projects</Button>
            </div>
          ) : null}
          <section className="oui-card opj-list oui-rise" style={{ animationDelay: "60ms" }} aria-label="Projects">
            <div key={tab} ref={listRef} className="opj-rows oui-scroll" role="listbox" aria-label="Projects" onKeyDown={moveSelection}>
              {visible.map((project, index) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  index={index}
                  isCurrent={!project.archived && selectedProject?.id === project.id}
                  isSelected={selected?.id === project.id}
                  onSelect={() => { setPickedId(project.id); setPhoneDetail(true); }}
                  onOpen={() => actions.handleOpenProject(project)}
                />
              ))}
              {tab !== "archived" && !searching ? (
                <button type="button" className="opj-add" onClick={() => openAddDialog(addMode)}>
                  <span className="opj-add-ring" aria-hidden="true"><Plus /></span>
                  {tab === "studio" ? "New Studio project" : "Add a project"}
                </button>
              ) : null}
            </div>
          </section>
          {selected ? (
            <ProjectDetail
              key={selected.id}
              project={selected}
              now={now}
              isCurrent={!selected.archived && selectedProject?.id === selected.id}
              busy={actions.projectActionId === selected.id}
              onOpen={() => actions.handleOpenProject(selected)}
              onSwitch={() => actions.handleSelectProject(selected)}
              onOpenTask={(taskId) => onNavigate?.("tasks", { projectId: selected.id, taskId, taskKnown: true })}
              onRename={(name) => actions.handleRenameProject(selected, name)}
              onArchive={() => void actions.handleArchiveProject(selected)}
              onRestore={() => void actions.handleRestoreProject(selected)}
              onDelete={() => actions.setProjectToDelete(selected)}
            />
          ) : null}
        </div>
      )}
    </OrbitPage>
  );
}
