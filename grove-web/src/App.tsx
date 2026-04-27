import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/Layout/Sidebar";
import { MobileHeader } from "./components/Layout/MobileHeader";
import { MobileDrawer } from "./components/Layout/MobileDrawer";
import { SettingsPage } from "./components/Config";
import { DashboardPage } from "./components/Dashboard";
import { BlitzPage } from "./components/Blitz";
import { TasksPage } from "./components/Tasks/TasksPage";
import { ResourcePage } from "./components/Studio";
import { WorkPage } from "./components/Work";
import { ProjectsPage } from "./components/Projects";
import { MissingProjectState } from "./components/Projects/MissingProjectState";
import { AddProjectDialog } from "./components/Projects/AddProjectDialog";
import { WelcomePage } from "./components/Welcome";
import { DiffReviewPage } from "./components/Review";
import { HelpOverlay } from "./components/Tasks/HelpOverlay";
import { SkillsPage } from "./components/Skills";
import { AIPage, GlobalAudioRecorder } from "./components/AI";
import { ProjectStatsPage } from "./components/Stats/ProjectStatsPage";
import { UpdateBanner } from "./components/ui/UpdateBanner";
import { CommandPalette } from "./components/ui/CommandPalette";
import { ProjectCommandPalette } from "./components/ui/ProjectCommandPalette";
import { TaskCommandPalette } from "./components/ui/TaskCommandPalette";
import { ThemeProvider, ProjectProvider, TerminalThemeProvider, NotificationProvider, ConfigProvider, CommandPaletteProvider, PreviewCommentProvider, useProject, useCommandPalette, useTheme } from "./context";
import { AuthGate } from "./components/AuthGate";
import type { Task } from "./data/types";
import { mockConfig } from "./data/mockData";
import { getConfig, patchConfig, checkCommands, openIDE, openTerminal } from "./api";
import { agentOptions } from "./components/ui";
import { useIsMobile, useHotkeys, buildCommands } from "./hooks";
import type { UseCommandsOptions } from "./hooks/useCommands";
import { REPO_NAV_IDS, STUDIO_NAV_IDS } from "./data/nav";

export type TasksMode = "zen" | "blitz";

// Main sidebar nav items for Cmd+1-6 and Option+Cmd+Up/Down cycling.
// "settings" and "projects" are excluded as they are utility pages, not part of the main nav cycle.
function AppContent() {
  const [activeItem, setActiveItem] = useState("dashboard");
  const [tasksMode, setTasksMode] = useState<TasksMode>("zen");
  const [tasksExitSignal, setTasksExitSignal] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Auto-collapse sidebar when the viewport is too narrow to host an expanded
  // sidebar (256px) plus the workspace's minimum content width. Keeps the
  // chat composer / panel system from being squeezed below their min-widths.
  // User's explicit collapse preference still takes precedence; we only force
  // collapse in the auto direction.
  const [viewportTooNarrowForSidebar, setViewportTooNarrowForSidebar] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SIDEBAR_EXPANDED_PX = 256;
    const CONTENT_MIN_PX = 900;
    const THRESHOLD = SIDEBAR_EXPANDED_PX + CONTENT_MIN_PX;
    const update = () => setViewportTooNarrowForSidebar(window.innerWidth < THRESHOLD);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const effectiveSidebarCollapsed = sidebarCollapsed || viewportTooNarrowForSidebar;
  const [hasExitedWelcome, setHasExitedWelcome] = useState(false);
  const [navigationData, setNavigationData] = useState<Record<string, unknown> | null>(null);
  const { selectedProject, currentProjectId, isLoading, selectProject, projects, addProject, createNewProject, refreshProjects, refreshSelectedProject } = useProject();
  const [showAddProject, setShowAddProject] = useState(false);
  const [addProjectInitialMode, setAddProjectInitialMode] = useState<"coding" | "studio">("coding");
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const { isMobile } = useIsMobile();
  const {
    open: openCommandPalette, openProjectPalette, openTaskPalette,
    closeProjectPalette, closeTaskPalette,
    projectPaletteOpen, taskPaletteOpen,
    registerGlobalCommands,
    inWorkspace,
  } = useCommandPalette();
  const { theme } = useTheme();
  const navItems: readonly string[] = selectedProject?.projectType === "studio" ? STUDIO_NAV_IDS : REPO_NAV_IDS;

  const setActiveNavItem = (index: number) => {
    const nextItem = navItems[index];
    if (nextItem) {
      setActiveItem(nextItem);
    }
  };
  // Navigate sidebar by absolute index or relative delta (based on current active item)
  const navigateSidebar = useCallback((indexOrDelta: number, relative?: boolean) => {
    if (relative) {
      const currentIndex = navItems.indexOf(activeItem);
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (baseIndex + indexOrDelta + navItems.length) % navItems.length;
      setActiveItem(navItems[nextIndex]);
    } else {
      const nextItem = navItems[indexOrDelta];
      if (nextItem) setActiveItem(nextItem);
    }
  }, [activeItem, navItems]);

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
    // Help overlay — lives at App level so it works from every page (Tasks,
    // Work, Dashboard, Skills, …) instead of only when TasksPage happens to
    // be the visible tab.
    { key: "?", handler: () => setShowHelp((v) => !v) },
  ], [openCommandPalette, openProjectPalette, openTaskPalette, isZenMode, inWorkspace, navigateSidebar]);

  // Allow any page's "help" button (e.g. Blitz toolbar) to open the same
  // overlay by dispatching a custom event instead of duplicating state.
  useEffect(() => {
    const open = () => setShowHelp(true);
    window.addEventListener("grove:open-help", open);
    return () => window.removeEventListener("grove:open-help", open);
  }, []);

  const handleSwitchToZen = useCallback(() => {
    setTasksMode("zen");
    refreshProjects();
    refreshSelectedProject();
  }, [refreshProjects, refreshSelectedProject]);

  const navigateToProjectDashboard = useCallback(() => {
    setActiveItem("dashboard");
    setNavigationData(null);
  }, []);

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
      const project = await addProject(path, name);
      selectProject(project);
      navigateToProjectDashboard();
      setShowAddProject(false);
    } catch (err) {
      setAddProjectError(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setIsAddingProject(false);
    }
  };

  const handleCreateNewProject = async (parentDir: string, name: string, initGit: boolean, projectType?: string) => {
    setIsAddingProject(true);
    setAddProjectError(null);
    try {
      const project = await createNewProject(parentDir, name, initGit, projectType);
      selectProject(project);
      navigateToProjectDashboard();
      setShowAddProject(false);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "message" in err) {
        setAddProjectError((err as { message: string }).message || "Failed to create project");
      } else {
        setAddProjectError("Failed to create project");
      }
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
    navigateToProjectDashboard();
  }, [navigateToProjectDashboard]);

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
    onAddProject: (studioMode?: "studio") => {
      setAddProjectInitialMode(studioMode === "studio" ? "studio" : "coding");
      setShowAddProject(true);
    },
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

  const handleItemClick = useCallback((item: string) => {
    if (item === "tasks" && activeItem === "tasks" && inWorkspace) {
      setTasksExitSignal(prev => prev + 1);
    } else {
      setActiveItem(item);
    }
  }, [activeItem, inWorkspace]);

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
        return <ProjectsPage onNavigate={setActiveItem} key={"projects-" + (navigationData?.tab ?? "coding")} initialTab={navigationData?.tab as "coding" | "studio" | undefined} />;
      case "work":
        return <WorkPage key="work" />;
      case "resource":
        return <ResourcePage />;
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
  const isFullWidthPage =
    isDashboardPage ||
    activeItem === "projects" ||
    activeItem === "work" ||
    activeItem === "skills" ||
    activeItem === "ai" ||
    activeItem === "resource";

  const sidebarProps = {
    activeItem,
    onItemClick: handleItemClick,
    collapsed: effectiveSidebarCollapsed,
    onToggleCollapse: () => setSidebarCollapsed(!sidebarCollapsed),
    onManageProjects: (tab?: "coding" | "studio") => handleNavigate("projects", { tab }),
    onAddProject: (studioMode?: "studio") => {
      setAddProjectInitialMode(studioMode === "studio" ? "studio" : "coding");
      setShowAddProject(true);
    },
    onNavigate: handleNavigate,
    tasksMode,
    onTasksModeChange: setTasksMode,
    onProjectSwitch: handleProjectSwitch,
    onSearch: openCommandPalette,
    tasks: selectedProject?.tasks ?? [],
    onTaskSelect: handleTaskSelectFromPalette,
    inWorkspace,
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

        <main className={`relative flex-1 ${isFullWidthPage && !isDashboardPage ? "overflow-hidden" : "overflow-y-auto"}`}>
          {/* TasksPage always mounted on mobile too */}
          <div
            className="h-full p-3"
            style={{ display: activeItem === "tasks" && tasksMode !== "blitz" ? "block" : "none" }}
          >
            <TasksPage
              initialTaskId={navigationData?.taskId as string | undefined}
              initialViewMode={navigationData?.viewMode as string | undefined}
              initialOpenNewTask={navigationData?.openNewTask as boolean | undefined}
              onNavigationConsumed={() => setNavigationData(null)}
              onNavByIndex={navigateSidebar}
              exitWorkspaceSignal={tasksExitSignal}
            />
          </div>
          <div className={isFullWidthPage ? "h-full p-3" : "max-w-5xl mx-auto p-3"}
               style={{ display: activeItem === "tasks" && tasksMode !== "blitz" ? "none" : undefined }}>
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
                  <BlitzPage onSwitchToZen={handleSwitchToZen} onNavigate={setActiveItem} />
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
          {selectedProject && !selectedProject.exists &&
            activeItem !== "projects" && activeItem !== "settings" && (
              <div className="absolute inset-0 z-40 bg-[var(--color-bg)] flex items-center justify-center">
                <MissingProjectState project={selectedProject} />
              </div>
            )}
        </main>

        <AddProjectDialog
          isOpen={showAddProject}
          onClose={() => {
            setShowAddProject(false);
            setAddProjectError(null);
          }}
          onAdd={handleAddProject}
          onCreateNew={handleCreateNewProject}
          isLoading={isAddingProject}
          externalError={addProjectError}
          initialMode={addProjectInitialMode}
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
            <BlitzPage onSwitchToZen={handleSwitchToZen} onNavigate={setActiveItem} />
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
            <main className={`relative flex-1 ${isFullWidthPage && !isDashboardPage ? "overflow-hidden" : "overflow-y-auto"}`}>
              {/* TasksPage always mounted to preserve workspace state across tab switches */}
              <div
                className={`h-full transition-[padding] duration-300 ease-out ${inWorkspace ? 'p-2' : 'p-6'}`}
                style={{ display: activeItem === "tasks" ? "block" : "none" }}
              >
                <TasksPage
                  initialTaskId={navigationData?.taskId as string | undefined}
                  initialViewMode={navigationData?.viewMode as string | undefined}
                  initialOpenNewTask={navigationData?.openNewTask as boolean | undefined}
                  onNavigationConsumed={() => setNavigationData(null)}
                  onNavByIndex={navigateSidebar}
                  exitWorkspaceSignal={tasksExitSignal}
                />
              </div>
              {activeItem !== "tasks" && (
                <div className={isFullWidthPage ? `h-full transition-[padding] duration-300 ease-out ${inWorkspace && activeItem === "work" ? 'p-2' : 'p-6'}` : "max-w-5xl mx-auto p-6"}>
                  {renderContent()}
                </div>
              )}
              {selectedProject && !selectedProject.exists &&
                activeItem !== "projects" && activeItem !== "settings" && (
                  <div className="absolute inset-0 z-40 bg-[var(--color-bg)] flex items-center justify-center">
                    <MissingProjectState project={selectedProject} />
                  </div>
                )}
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
        onCreateNew={handleCreateNewProject}
        isLoading={isAddingProject}
        externalError={addProjectError}
        initialMode={addProjectInitialMode}
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
      <HelpOverlay isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}

function App() {
  // Check for /review/{projectId}/{taskId} path — render diff review directly
  const reviewMatch = window.location.pathname.match(/^\/review\/([^/]+)\/([^/]+)/);
  if (reviewMatch) {
    return (
      <ThemeProvider>
        <PreviewCommentProvider>
          <DiffReviewPage projectId={reviewMatch[1]} taskId={reviewMatch[2]} />
        </PreviewCommentProvider>
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
                  <PreviewCommentProvider>
                    <AppContent />
                  </PreviewCommentProvider>
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
