import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/Layout/Sidebar";
import { SettingsPage } from "./components/Config";
import { DashboardPage } from "./components/Dashboard";
import { BlitzPage } from "./components/Blitz";
import { TasksPage } from "./components/Tasks/TasksPage";
import { ProjectsPage } from "./components/Projects";
import { AddProjectDialog } from "./components/Projects/AddProjectDialog";
import { WelcomePage } from "./components/Welcome";
import { DiffReviewPage } from "./components/Review";
import { SkillsPage } from "./components/Skills";
import { UpdateBanner } from "./components/ui/UpdateBanner";
import { ThemeProvider, ProjectProvider, TerminalThemeProvider, NotificationProvider, ConfigProvider, useProject } from "./context";
import { mockConfig } from "./data/mockData";
import { getConfig, patchConfig, checkCommands } from "./api";
import { agentOptions } from "./components/ui";

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

  // Initialize agent configuration on app startup
  useEffect(() => {
    const initializeAgentConfig = async () => {
      try {
        // Load current config
        const cfg = await getConfig();

        // Check command availability
        const cmds = new Set<string>();
        for (const opt of agentOptions) {
          if (opt.terminalCheck) cmds.add(opt.terminalCheck);
          if (opt.acpCheck) cmds.add(opt.acpCheck);
        }
        const commandAvailability = await checkCommands([...cmds]);

        let needsUpdate = false;
        const updates: { layout?: { agent_command?: string }, acp?: { agent_command?: string } } = {};

        // Check Terminal Agent (if enabled)
        const isTerminalEnabled = cfg.enable_terminal;

        if (isTerminalEnabled && cfg.layout?.agent_command) {
          const currentAgent = agentOptions.find(a => a.id === cfg.layout.agent_command);
          const cmd = currentAgent?.terminalCheck;
          if (cmd && commandAvailability[cmd] === false) {
            // Find first available terminal agent
            const firstAvailable = agentOptions.find(a => {
              const check = a.terminalCheck;
              return check && commandAvailability[check] !== false;
            });
            if (firstAvailable) {
              updates.layout = { agent_command: firstAvailable.id };
              needsUpdate = true;
            }
          }
        }

        // Check Chat Agent (if enabled)
        const acpCompatibleIds = ["claude", "traecli", "codex", "kimi", "gh-copilot", "gemini", "qwen", "opencode"];
        const isChatEnabled = cfg.enable_chat;

        if (isChatEnabled && cfg.acp?.agent_command) {
          const currentAgent = agentOptions.find(a => a.id === cfg.acp.agent_command);
          const cmd = currentAgent?.acpCheck;
          if (cmd && commandAvailability[cmd] === false) {
            // Find first available chat agent
            const firstAvailable = agentOptions.find(a => {
              const check = a.acpCheck;
              return acpCompatibleIds.includes(a.id) && check && commandAvailability[check] !== false;
            });
            if (firstAvailable) {
              updates.acp = { agent_command: firstAvailable.id };
              needsUpdate = true;
            }
          }
        }

        // Save updated config if needed
        if (needsUpdate) {
          await patchConfig(updates);
          console.log("Auto-corrected agent configuration:", updates);
        }
      } catch (err) {
        console.error("Failed to initialize agent configuration:", err);
      }
    };

    initializeAgentConfig();
  }, []);

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

  // Auto-navigate to dashboard when a project is auto-selected via currentProjectId
  useEffect(() => {
    if (currentProjectId && selectedProject && !hasExitedWelcome) {
      setHasExitedWelcome(true);
      setActiveItem("dashboard");
    }
  }, [currentProjectId, selectedProject, hasExitedWelcome]);

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
            initialViewMode={navigationData?.viewMode as string | undefined}
            onNavigationConsumed={() => setNavigationData(null)}
          />
        );
      case "skills":
        return <SkillsPage />;
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

  const isFullWidthPage = activeItem === "tasks" || activeItem === "skills";

  return (
    <div className="flex h-screen bg-[var(--color-bg)] overflow-hidden">
      <UpdateBanner />
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
      <ConfigProvider>
        <TerminalThemeProvider>
          <ProjectProvider>
            <NotificationProvider>
              <AppContent />
            </NotificationProvider>
          </ProjectProvider>
        </TerminalThemeProvider>
      </ConfigProvider>
    </ThemeProvider>
  );
}

export default App;
