import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/Layout/Sidebar";
import { SettingsPage } from "./components/Config";
import { DashboardPage } from "./components/Dashboard";
import { TasksPage } from "./components/Tasks";
import { BlitzPage } from "./components/Blitz";
import { ProjectsPage } from "./components/Projects";
import { AddProjectDialog } from "./components/Projects/AddProjectDialog";
import { WelcomePage } from "./components/Welcome";
import { DiffReviewPage } from "./components/Review";
import { ThemeProvider, ProjectProvider, TerminalThemeProvider, NotificationProvider, useProject } from "./context";
import { mockConfig } from "./data/mockData";

export type TasksMode = "zen" | "blitz";

function AppContent() {
  const [activeItem, setActiveItem] = useState("dashboard");
  const [tasksMode, setTasksMode] = useState<TasksMode>("zen");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [hasExitedWelcome, setHasExitedWelcome] = useState(false);
  const [navigationData, setNavigationData] = useState<Record<string, unknown> | null>(null);
  const { selectedProject, currentProjectId, isLoading, selectProject, projects, addProject } = useProject();
  const [showAddProject, setShowAddProject] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);

  const handleAddProject = async (path: string, name?: string) => {
    setIsAddingProject(true);
    setAddProjectError(null);
    try {
      await addProject(path, name);
      setShowAddProject(false);
    } catch (err) {
      setAddProjectError(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setIsAddingProject(false);
    }
  };

  // Check if we should show welcome page
  const shouldShowWelcome = currentProjectId === null && !hasExitedWelcome;

  // Update document title based on current view
  useEffect(() => {
    if (shouldShowWelcome) {
      document.title = "Grove";
    } else if (selectedProject) {
      document.title = `${selectedProject.name} - Grove`;
    } else {
      document.title = "Grove";
    }
  }, [selectedProject, shouldShowWelcome]);

  const handleGetStarted = () => {
    setHasExitedWelcome(true);
    setActiveItem("projects");
  };

  const handleNavigate = (page: string, data?: Record<string, unknown>) => {
    if (data?.projectId) {
      const target = projects.find((p) => p.id === data.projectId);
      if (target) {
        selectProject(target);
      }
    }
    setActiveItem(page);
    setNavigationData(data ?? null);
  };

  // When project changes via sidebar ProjectSelector, go back to dashboard
  const handleProjectSwitch = useCallback(() => {
    setActiveItem("dashboard");
  }, []);

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex h-screen bg-[var(--color-bg)] items-center justify-center">
        <div className="w-8 h-8 border-2 border-[var(--color-highlight)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Show Welcome page
  if (shouldShowWelcome) {
    return <WelcomePage onGetStarted={handleGetStarted} />;
  }

  const renderContent = () => {
    switch (activeItem) {
      case "dashboard":
        return <DashboardPage onNavigate={handleNavigate} />;
      case "projects":
        return <ProjectsPage onNavigate={setActiveItem} />;
      case "tasks":
        return (
          <TasksPage
            initialTaskId={navigationData?.taskId as string | undefined}
            onNavigationConsumed={() => setNavigationData(null)}
          />
        );
      case "settings":
        return <SettingsPage config={mockConfig} />;
      default:
        return (
          <div className="flex items-center justify-center h-full min-h-[60vh]">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-[var(--color-text)] mb-2 capitalize">
                {activeItem}
              </h2>
              <p className="text-[var(--color-text-muted)]">
                This page is coming soon.
              </p>
            </div>
          </div>
        );
    }
  };

  const isFullWidthPage = activeItem === "tasks";

  return (
    <div className="flex h-screen bg-[var(--color-bg)] overflow-hidden">
      <AnimatePresence mode="wait">
        {tasksMode === "blitz" ? (
          <motion.div
            key="blitz"
            className="flex w-full h-full"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          >
            <BlitzPage onSwitchToZen={() => setTasksMode("zen")} />
          </motion.div>
        ) : (
          <motion.div
            key="zen"
            className="flex w-full h-full"
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          >
            <Sidebar
              activeItem={activeItem}
              onItemClick={setActiveItem}
              collapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
              onManageProjects={() => setActiveItem("projects")}
              onAddProject={() => setShowAddProject(true)}
              onNavigate={handleNavigate}
              tasksMode={tasksMode}
              onTasksModeChange={setTasksMode}
              onProjectSwitch={handleProjectSwitch}
            />
            <main className={`flex-1 ${isFullWidthPage ? "overflow-hidden" : "overflow-y-auto"}`}>
              <div className={isFullWidthPage ? "h-full p-6" : "max-w-5xl mx-auto p-6"}>
                {renderContent()}
              </div>
            </main>
          </motion.div>
        )}
      </AnimatePresence>
      <AddProjectDialog
        isOpen={showAddProject}
        onClose={() => {
          setShowAddProject(false);
          setAddProjectError(null);
        }}
        onAdd={handleAddProject}
        isLoading={isAddingProject}
        externalError={addProjectError}
      />
    </div>
  );
}

function App() {
  // Check for /review/{projectId}/{taskId} path — render diff review directly
  const reviewMatch = window.location.pathname.match(/^\/review\/([^/]+)\/([^/]+)/);
  if (reviewMatch) {
    return (
      <ThemeProvider>
        <DiffReviewPage projectId={reviewMatch[1]} taskId={reviewMatch[2]} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <TerminalThemeProvider>
        <ProjectProvider>
          <NotificationProvider>
            <AppContent />
          </NotificationProvider>
        </ProjectProvider>
      </TerminalThemeProvider>
    </ThemeProvider>
  );
}

export default App;
