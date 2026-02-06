import { useState, useEffect } from "react";
import { Sidebar } from "./components/Layout/Sidebar";
import { SettingsPage } from "./components/Config";
import { DashboardPage } from "./components/Dashboard";
import { TasksPage } from "./components/Tasks";
import { ProjectsPage } from "./components/Projects";
import { WelcomePage } from "./components/Welcome";
import { ThemeProvider, ProjectProvider, TerminalThemeProvider, useProject } from "./context";
import { mockConfig } from "./data/mockData";

function AppContent() {
  const [activeItem, setActiveItem] = useState("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [hasExitedWelcome, setHasExitedWelcome] = useState(false);
  const [navigationData, setNavigationData] = useState<Record<string, unknown> | null>(null);
  const { selectedProject, currentProjectId, isLoading } = useProject();

  // Check if we should show welcome page
  const shouldShowWelcome = showWelcome || (currentProjectId === null && !hasExitedWelcome);

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
    setShowWelcome(false);
    setHasExitedWelcome(true);
    setActiveItem("projects"); // Go to projects management page
  };

  const handleNavigate = (page: string, data?: Record<string, unknown>) => {
    setActiveItem(page);
    setNavigationData(data || null);
  };

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex h-screen bg-[var(--color-bg)] items-center justify-center">
        <div className="w-8 h-8 border-2 border-[var(--color-highlight)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Show Welcome page if:
  // 1. User explicitly requested it (clicked logo)
  // 2. Not running in a git repo directory (currentProjectId is null) AND user hasn't clicked "Get Started"
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

  // Tasks page needs full width, other pages have max-width
  const isFullWidthPage = activeItem === "tasks";

  return (
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
  );
}

function App() {
  return (
    <ThemeProvider>
      <TerminalThemeProvider>
        <ProjectProvider>
          <AppContent />
        </ProjectProvider>
      </TerminalThemeProvider>
    </ThemeProvider>
  );
}

export default App;
