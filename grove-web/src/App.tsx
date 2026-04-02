import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/Layout/Sidebar";
import { MobileHeader } from "./components/Layout/MobileHeader";
import { MobileDrawer } from "./components/Layout/MobileDrawer";
import { SettingsPage } from "./components/Config";
import { DashboardPage } from "./components/Dashboard";
import { BlitzPage } from "./components/Blitz";
import { TasksPage } from "./components/Tasks/TasksPage";
import { ProjectsPage } from "./components/Projects";
import { AddProjectDialog } from "./components/Projects/AddProjectDialog";
import { WelcomePage } from "./components/Welcome";
import { DiffReviewPage } from "./components/Review";
import { SkillsPage } from "./components/Skills";
import { AIPage, GlobalAudioRecorder } from "./components/AI";
import { ProjectStatsPage } from "./components/Stats/ProjectStatsPage";
import { UpdateBanner } from "./components/ui/UpdateBanner";
import { CommandPalette } from "./components/ui/CommandPalette";
import { ProjectCommandPalette } from "./components/ui/ProjectCommandPalette";
import { TaskCommandPalette } from "./components/ui/TaskCommandPalette";
import { ThemeProvider, ProjectProvider, TerminalThemeProvider, NotificationProvider, ConfigProvider, CommandPaletteProvider, useProject, useCommandPalette, useTheme } from "./context";
import { AuthGate } from "./components/AuthGate";
import type { Task } from "./data/types";
import { mockConfig } from "./data/mockData";
import { getConfig, patchConfig, checkCommands, openIDE, openTerminal } from "./api";
import { agentOptions } from "./components/ui";
import { useIsMobile, useHotkeys, buildCommands } from "./hooks";
import type { UseCommandsOptions } from "./hooks/useCommands";

export type TasksMode = "zen" | "blitz";

// Main sidebar nav items for Cmd+1-6 and Option+Cmd+Up/Down cycling.
// "settings" and "projects" are excluded as they are utility pages, not part of the main nav cycle.
const NAV_ITEMS = ["dashboard", "work", "tasks", "skills", "ai", "statistics"] as const;

function AppContent() {
  const [activeItem, setActiveItem] = useState("dashboard");
  const [tasksMode, setTasksMode] = useState<TasksMode>("zen");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [hasExitedWelcome, setHasExitedWelcome] = useState(false);
  const [navigationData, setNavigationData] = useState<Record<string, unknown> | null>(null);
  const { selectedProject, currentProjectId, isLoading, selectProject, projects, addProject, refreshProjects, refreshSelectedProject } = useProject();
  const [showAddProject, setShowAddProject] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { isMobile } = useIsMobile();
  const {
    open: openCommandPalette, openProjectPalette, openTaskPalette,
    closeProjectPalette, closeTaskPalette,
    projectPaletteOpen, taskPaletteOpen,
    registerGlobalCommands,
    inWorkspace,
  } = useCommandPalette();
  const { theme } = useTheme();

  const setActiveNavItem = (index: number) => {
    const nextItem = NAV_ITEMS[index];
    if (nextItem) {
      setActiveItem(nextItem);
    }
  };
  // Navigate sidebar by absolute index or relative delta (based on current active item)
  const navigateSidebar = useCallback((indexOrDelta: number, relative?: boolean) => {
    if (relative) {
      const currentIndex = NAV_ITEMS.indexOf(activeItem as typeof NAV_ITEMS[number]);
      const nextIndex = (currentIndex + indexOrDelta + NAV_ITEMS.length) % NAV_ITEMS.length;
      setActiveItem(NAV_ITEMS[nextIndex]);
    } else {
      const nextItem = NAV_ITEMS[indexOrDelta];
      if (nextItem) setActiveItem(nextItem);
    }
  }, [activeItem]);

  const isZenMode = tasksMode === "zen";

  // Cmd+K = command palette, Cmd+P = project palette, Cmd+T = task palette
  // Cmd+1-5 = tab switch (Zen mode only; Blitz uses Cmd+1-9 for task selection)
  useHotkeys([
    { key: "Meta+k", handler: openCommandPalette },
    { key: "Meta+p", handler: openProjectPalette },
    { key: "Meta+o", handler: openTaskPalette },
    { key: "Meta+1", handler: () => setActiveNavItem(0), options: { enabled: isZenMode && !inWorkspace } },
    { key: "Meta+2", handler: () => setActiveNavItem(1), options: { enabled: isZenMode && !inWorkspace } },
    { key: "Meta+3", handler: () => setActiveNavItem(2), options: { enabled: isZenMode && !inWorkspace } },
    { key: "Meta+4", handler: () => setActiveNavItem(3), options: { enabled: isZenMode && !inWorkspace } },
    { key: "Meta+5", handler: () => setActiveNavItem(4), options: { enabled: isZenMode && !inWorkspace } },
    { key: "Meta+6", handler: () => setActiveNavItem(5), options: { enabled: isZenMode && !inWorkspace } },
    { key: "Meta+Alt+ArrowUp", handler: () => navigateSidebar(-1, true), options: { enabled: isZenMode && !inWorkspace } },
    { key: "Meta+Alt+ArrowDown", handler: () => navigateSidebar(1, true), options: { enabled: isZenMode && !inWorkspace } },
  ], [openCommandPalette, openProjectPalette, openTaskPalette, isZenMode, inWorkspace, navigateSidebar]);

  const handleSwitchToZen = useCallback(() => {
    setTasksMode("zen");
    refreshProjects();
    refreshSelectedProject();
  }, [refreshProjects, refreshSelectedProject]);

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

        // Check Terminal Agent
        if (cfg.layout?.agent_command) {
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

        // Check Chat Agent
        if (cfg.acp?.agent_command) {
          const currentAgent = agentOptions.find(a => a.id === cfg.acp.agent_command);
          const cmd = currentAgent?.acpCheck;
          if (cmd && commandAvailability[cmd] === false) {
            // Find first available chat agent
            const firstAvailable = agentOptions.find(a => {
              const check = a.acpCheck;
              return check && commandAvailability[check] !== false;
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

  // Task palette: navigate to tasks page and select the task
  const handleTaskSelectFromPalette = useCallback((task: Task) => {
    if (task.isLocal) {
      setActiveItem("work");
    } else {
      setActiveItem("tasks");
      setNavigationData({ taskId: task.id });
    }
  }, []);

  // Register global commands for the command palette
  const toggleMode = useCallback(() => {
    setTasksMode((prev) => (prev === "zen" ? "blitz" : "zen"));
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);
  const handleOpenIDE = useCallback(() => {
    if (selectedProject) openIDE(selectedProject.id);
  }, [selectedProject]);
  const handleOpenTerminal = useCallback(() => {
    if (selectedProject) openTerminal(selectedProject.id);
  }, [selectedProject]);

  // Register global command builder — uses refs internally, no re-renders
  const globalOptionsRef = useRef<UseCommandsOptions>(null!);
  globalOptionsRef.current = {
    navigation: {
      onNavigate: setActiveItem,
      activeItem,
    },
    project: {
      projects,
      selectedProject,
      onSelectProject: selectProject,
      onAddProject: () => setShowAddProject(true),
      onProjectSwitch: handleProjectSwitch,
      accentPalette: theme.accentPalette,
    },
    mode: {
      tasksMode,
      onToggleMode: toggleMode,
      onToggleSidebar: toggleSidebar,
    },
    palettes: {
      onOpenProjectPalette: openProjectPalette,
      onOpenTaskPalette: openTaskPalette,
    },
    projectActions: selectedProject ? {
      onOpenIDE: handleOpenIDE,
      onOpenTerminal: handleOpenTerminal,
    } : undefined,
  };

  useEffect(() => {
    registerGlobalCommands(() => buildCommands(globalOptionsRef.current));
  }, [registerGlobalCommands]);

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
      case "work":
        return <TasksPage key="work" localMode onNavByIndex={navigateSidebar} />;
      case "tasks":
        return (
          <TasksPage
            key="tasks"
            initialTaskId={navigationData?.taskId as string | undefined}
            initialViewMode={navigationData?.viewMode as string | undefined}
            initialOpenNewTask={navigationData?.openNewTask as boolean | undefined}
            onNavigationConsumed={() => setNavigationData(null)}
            onNavByIndex={navigateSidebar}
          />
        );
      case "skills":
        return <SkillsPage />;
      case "ai":
        return <AIPage />;
      case "statistics":
        return <ProjectStatsPage projectId={selectedProject?.id} />;
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

  const isDashboardPage = activeItem === "dashboard";
  const isFullWidthPage = isDashboardPage || activeItem === "tasks" || activeItem === "work" || activeItem === "skills" || activeItem === "ai";

  const sidebarProps = {
    activeItem,
    onItemClick: setActiveItem,
    collapsed: sidebarCollapsed,
    onToggleCollapse: () => setSidebarCollapsed(!sidebarCollapsed),
    onManageProjects: () => setActiveItem("projects"),
    onAddProject: () => setShowAddProject(true),
    onNavigate: handleNavigate,
    tasksMode,
    onTasksModeChange: setTasksMode,
    onProjectSwitch: handleProjectSwitch,
    onSearch: openCommandPalette,
  };

  // Mobile layout
  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-[var(--color-bg)] overflow-hidden">
        <UpdateBanner />
        <MobileHeader
          onMenuOpen={() => setDrawerOpen(true)}
          onNotificationOpen={() => {
            setDrawerOpen(true);
            // Notification will be accessible from drawer sidebar
          }}
        />
        <MobileDrawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <Sidebar
            {...sidebarProps}
            drawerMode
            onDrawerClose={() => setDrawerOpen(false)}
          />
        </MobileDrawer>

        <main className={`flex-1 ${isFullWidthPage && !isDashboardPage ? "overflow-hidden" : "overflow-y-auto"}`}>
          <div className={isFullWidthPage ? "h-full p-3" : "max-w-5xl mx-auto p-3"}>
            <AnimatePresence mode="wait">
              {tasksMode === "blitz" ? (
                <motion.div
                  key="blitz"
                  className="w-full h-full"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <BlitzPage onSwitchToZen={handleSwitchToZen} />
                </motion.div>
              ) : (
                <motion.div
                  key="zen-content"
                  className="w-full h-full"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {renderContent()}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>

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
        <CommandPalette />
        <ProjectCommandPalette
          isOpen={projectPaletteOpen}
          onClose={closeProjectPalette}
          onProjectSelect={handleProjectSwitch}
        />
        <TaskCommandPalette
          isOpen={taskPaletteOpen}
          onClose={closeTaskPalette}
          tasks={selectedProject?.tasks ?? []}
          selectedTask={null}
          onTaskSelect={handleTaskSelectFromPalette}
        />
        <GlobalAudioRecorder projectId={selectedProject?.id ?? null} />
      </div>
    );
  }

  // Desktop layout (unchanged)
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
            <BlitzPage onSwitchToZen={handleSwitchToZen} />
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
            <Sidebar {...sidebarProps} />
            <main className={`flex-1 ${isFullWidthPage && !isDashboardPage ? "overflow-hidden" : "overflow-y-auto"}`}>
              <div className={isFullWidthPage ? `h-full transition-[padding] duration-300 ease-out ${inWorkspace ? 'p-2' : 'p-6'}` : "max-w-5xl mx-auto p-6"}>
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
      <CommandPalette />
      <ProjectCommandPalette
        isOpen={projectPaletteOpen}
        onClose={closeProjectPalette}
        onProjectSelect={handleProjectSwitch}
      />
      <TaskCommandPalette
        isOpen={taskPaletteOpen}
        onClose={closeTaskPalette}
        tasks={selectedProject?.tasks ?? []}
        selectedTask={null}
        onTaskSelect={handleTaskSelectFromPalette}
      />
      <GlobalAudioRecorder projectId={selectedProject?.id ?? null} />
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
      <AuthGate>
        <ConfigProvider>
          <TerminalThemeProvider>
            <ProjectProvider>
              <NotificationProvider>
                <CommandPaletteProvider>
                  <AppContent />
                </CommandPaletteProvider>
              </NotificationProvider>
            </ProjectProvider>
          </TerminalThemeProvider>
        </ConfigProvider>
      </AuthGate>
    </ThemeProvider>
  );
}

export default App;
