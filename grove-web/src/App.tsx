import { useState, useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/Layout/Sidebar";
import { SettingsPage } from "./components/Config";
import { DashboardPage } from "./components/Dashboard";
import { TasksPage } from "./components/Tasks";
import { ProjectSelectorPage, ProjectsPage } from "./components/Projects";
import { WelcomePage } from "./components/Welcome";
import { ThemeProvider, ProjectProvider, useProject } from "./context";
import { mockConfig } from "./data/mockData";

const WELCOME_SHOWN_KEY = "grove-welcome-shown";

function AppContent() {
  const [activeItem, setActiveItem] = useState("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const { selectedProject, isLoading } = useProject();

  // Check if welcome page should be shown
  useEffect(() => {
    const hasSeenWelcome = localStorage.getItem(WELCOME_SHOWN_KEY);
    if (!hasSeenWelcome) {
      setShowWelcome(true);
    }
  }, []);

  // Update document title based on selected project
  useEffect(() => {
    if (selectedProject) {
      document.title = `${selectedProject.name} - Grove`;
    } else {
      document.title = "Grove";
    }
  }, [selectedProject]);

  const handleGetStarted = () => {
    localStorage.setItem(WELCOME_SHOWN_KEY, "true");
    setShowWelcome(false);
  };

  const handleNavigate = (page: string, _data?: Record<string, unknown>) => {
    setActiveItem(page);
  };

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex h-screen bg-[var(--color-bg)] items-center justify-center">
        <div className="w-8 h-8 border-2 border-[var(--color-highlight)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Settings is always accessible, even without a project selected
  // For other pages, require project selection
  const requiresProject = activeItem !== "settings";
  const showProjectSelector = requiresProject && !selectedProject && !showWelcome;

  if (showProjectSelector) {
    return (
      <ProjectSelectorPage
        onProjectSelected={() => setActiveItem("dashboard")}
      />
    );
  }

  const renderContent = () => {
    switch (activeItem) {
      case "dashboard":
        return <DashboardPage onNavigate={handleNavigate} />;
      case "projects":
        return <ProjectsPage />;
      case "tasks":
        return <TasksPage />;
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

  // Tasks page needs full width, other pages have max-width
  const isFullWidthPage = activeItem === "tasks";

  return (
    <>
      {/* Welcome Page */}
      <AnimatePresence>
        {showWelcome && <WelcomePage onGetStarted={handleGetStarted} />}
      </AnimatePresence>

      {/* Main App */}
      <div className="flex h-screen bg-[var(--color-bg)]">
        <Sidebar
          activeItem={activeItem}
          onItemClick={setActiveItem}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onManageProjects={() => setActiveItem("projects")}
          onLogoClick={() => setShowWelcome(true)}
        />
        <main className={`flex-1 ${isFullWidthPage ? "overflow-hidden" : "overflow-y-auto"}`}>
          <div className={isFullWidthPage ? "h-full p-6" : "max-w-5xl mx-auto p-6"}>
            {renderContent()}
          </div>
        </main>
      </div>
    </>
  );
}

function App() {
  return (
    <ThemeProvider>
      <ProjectProvider>
        <AppContent />
      </ProjectProvider>
    </ThemeProvider>
  );
}

export default App;
