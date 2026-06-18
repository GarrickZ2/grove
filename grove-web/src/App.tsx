import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ShortcutHandler } from "@tauri-apps/plugin-global-shortcut";
import { Sidebar } from "./components/Layout/Sidebar";
import { PluginFrame } from "./components/Plugins/PluginFrame";
import { listPlugins, type Plugin } from "./api/plugins";
import { MobileHeader } from "./components/Layout/MobileHeader";
import { MobileDrawer } from "./components/Layout/MobileDrawer";
import { NotificationPopover } from "./components/Layout/NotificationPopover";
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
import { AutomationPage } from "./components/Automation/AutomationPage";
import { ProjectStatsPage } from "./components/Stats/ProjectStatsPage";
import { UpdateBanner } from "./components/ui/UpdateBanner";
import { CommandPalette } from "./components/ui/CommandPalette";
import { ProjectCommandPalette } from "./components/ui/ProjectCommandPalette";
import { TaskCommandPalette } from "./components/ui/TaskCommandPalette";
import { ThemeProvider, BannerProvider, ProjectProvider, TerminalThemeProvider, NotificationProvider, ConfigProvider, CommandPaletteProvider, PreviewCommentProvider, useProject, useCommandPalette, useTheme, useConfig } from "./context";
import { ConfirmDialog } from "./components/Dialogs";
import { useReportDebugId } from "./perf/debugIdsStore";
import { AuthGate } from "./components/AuthGate";
import { OptionalPerfProfiler } from "./perf/profilerShim";
import type { Task } from "./data/types";
import { mockConfig } from "./data/mockData";
import { getConfig, patchConfig, openIDE, openTerminal } from "./api";
import { listMarketplace } from "./api/marketplace";
import { setMarketplaceIcons } from "./utils/agentIcon";
import { useIsMobile, buildCommands, useAddLibraryHashHandler } from "./hooks";
import type { UseCommandsOptions } from "./hooks/useCommands";
import { REPO_NAV_IDS, STUDIO_NAV_IDS } from "./data/nav";
import { readLastProjectView, writeLastProjectView } from "./utils/lastProjectView";
import { useCommand, useContextKey, commandRegistry } from "./keyboard";
import { ActionCommandPalette } from "./components/Palette/ActionCommandPalette";

export type TasksMode = "zen" | "blitz";

// Register a process-global hotkey that survives a webview reload (Cmd+R).
// The native registration lives on the Rust side and lingers after a reload
// while its JS callback dies, so the next mount's register() throws "already
// registered" and the fresh callback never binds (the shortcut goes dead). We
// catch that, clear the stale binding, and retry once. Returns a cleanup that
// unregisters on unmount; a no-op outside Tauri or when the shortcut is empty.
function registerGlobalShortcut(
  displayShortcut: string,
  handler: ShortcutHandler,
  label: string,
): () => void {
  const isTauri = !!((window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }).__TAURI__ || (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (!isTauri || !displayShortcut) return () => {};

  const tauriShortcut = displayShortcut
    .split("+")
    .map((part) => part === "Cmd" ? "CommandOrControl" : part === "Ctrl" ? "Control" : part)
    .join("+");
  let registered = false;
  let disposed = false;
  const unregisterShortcut = () => {
    import("@tauri-apps/plugin-global-shortcut")
      .then(({ unregister }) => unregister(tauriShortcut))
      .catch((err) => console.error(`Failed to unregister ${label} shortcut:`, err));
  };

  import("@tauri-apps/plugin-global-shortcut")
    .then(async ({ register, unregister }) => {
      if (disposed) return false;
      try {
        await register(tauriShortcut, handler);
      } catch {
        // Stale registration from a prior reload blocks us — drop it and retry
        // once so the live callback actually binds.
        try {
          await unregister(tauriShortcut);
        } catch {
          // Nothing stale to clear — fall through to the retry.
        }
        await register(tauriShortcut, handler);
      }
      return true;
    })
    .then((didRegister) => {
      if (!didRegister) return;
      if (disposed) {
        unregisterShortcut();
        return;
      }
      registered = true;
    })
    .catch((err) => {
      if (!disposed) console.error(`Failed to register ${label} shortcut:`, err);
    });

  return () => {
    disposed = true;
    if (!registered) return;
    unregisterShortcut();
  };
}

// Main sidebar nav items for Cmd+1-6 and Option+Cmd+Up/Down cycling.
// "settings" and "projects" are excluded as they are utility pages, not part of the main nav cycle.
function AppContent() {
  "use no memo";
  // AppContent uses two dynamic `import()` calls for code-splitting heavy
  // panels. React Compiler 1.0 can't lower dynamic imports, so we opt
  // this root component out. Affected children are still memoized normally.

  // Handle libraries.excalidraw.com "Add to Excalidraw" callback once at
  // load: if the URL hash carries `addLibrary=`, fetch the library, ask the
  // user to confirm via ConfirmDialog (rendered below), then install and
  // broadcast to peer tabs. Runs on any landing page — the callback tab
  // can't be guaranteed to land on a sketch view.
  const addLibrary = useAddLibraryHashHandler();

  const [activeItem, setActiveItem] = useState("dashboard");
  const [tasksMode, setTasksMode] = useState<TasksMode>("zen");
  // Ref mirror of tasksMode for use inside stable callbacks (e.g. the
  // tray:navigate listener) that capture the initial closure and would
  // otherwise see a stale mode. Sync via effect — refs cannot be
  // mutated during render.
  const tasksModeRef = useRef(tasksMode);
  useEffect(() => {
    tasksModeRef.current = tasksMode;
  }, [tasksMode]);
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

  // Approximate native macOS "scroll bars: when scrolling" behavior. Listen
  // for any scroll event in capture phase and flip a body class so the
  // .blitz-area scrollbar thumb appears for ~900ms after the last scroll,
  // then fades away. CSS-only :hover proved unreliable (webkit pseudo-
  // elements don't always honor ancestor hover state for scrollbar
  // visibility), so this is the standard escape hatch.
  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      document.body.classList.add("grove-scrolling");
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        document.body.classList.remove("grove-scrolling");
      }, 900);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      if (hideTimer) clearTimeout(hideTimer);
      document.body.classList.remove("grove-scrolling");
    };
  }, []);

  // Top-edge drag for Tauri Overlay title-bar mode. data-tauri-drag-region
  // alone gives us double-click-maximize but NOT drag when the webview is
  // loaded from an external URL (http://localhost) — drag silently fails
  // after the first attempt. Bind a native (non-React) mousedown listener
  // and call startDragging() ourselves. Native listener avoids the stale
  // event-handler issue observed with React's synthetic events here.
  useEffect(() => {
    let win: { startDragging: () => Promise<void> } | null = null;
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then((mod) => {
        if (cancelled) return;
        win = mod.getCurrentWindow();
      })
      .catch(() => {
        // Not in Tauri runtime — leave win null, handler becomes a no-op
      });

    const handler = (e: MouseEvent) => {
      if (!win) return;
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-window-drag-strip]')) return;
      void win.startDragging().catch(() => {});
    };
    document.addEventListener("mousedown", handler);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", handler);
    };
  }, []);

  const effectiveSidebarCollapsed = sidebarCollapsed || viewportTooNarrowForSidebar;
  const [hasExitedWelcome, setHasExitedWelcome] = useState(false);
  const [navigationData, setNavigationData] = useState<Record<string, unknown> | null>(null);

  // Installed plugins that contribute a top-level sidebar page. Loaded once;
  // the sidebar renders a nav entry per plugin (id `plugin:<id>`) and
  // renderContent renders the plugin full-page when one is active.
  const [sidebarPlugins, setSidebarPlugins] = useState<Plugin[]>([]);
  useEffect(() => {
    let cancelled = false;
    listPlugins()
      .then((ps) => {
        if (!cancelled) setSidebarPlugins(ps.filter((p) => p.contributes?.sidebar));
      })
      .catch(() => {
        if (!cancelled) setSidebarPlugins([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const { selectedProject, currentProjectId, isLoading, selectProject, projects, addProject, createNewProject, cloneProject, refreshProjects, refreshSelectedProject } = useProject();
  useReportDebugId("projectId", selectedProject?.id ?? null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [addProjectInitialMode, setAddProjectInitialMode] = useState<"coding" | "studio">("coding");
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileNotifOpen, setMobileNotifOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const { isMobile } = useIsMobile();
  const {
    open: openCommandPalette,
    toggle: toggleCommandPalette,
    openProjectPalette, openTaskPalette,
    toggleProjectPalette, toggleTaskPalette,
    closeProjectPalette, closeTaskPalette,
    projectPaletteOpen, taskPaletteOpen,
    registerGlobalCommands,
    inWorkspace,
  } = useCommandPalette();
  const { theme, mode: themeMode, setAppearance } = useTheme();
  const { config: globalConfig } = useConfig();
  const navItems: readonly string[] = selectedProject?.projectType === "studio" ? STUDIO_NAV_IDS : REPO_NAV_IDS;

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

  // Global context keys — feed catalog `when` expressions for nav.* /
  // project.* / mode.* etc. Last-write-wins; we own these four at the
  // App level.
  useContextKey("projectSelected", !!selectedProject);
  useContextKey("studioProject", selectedProject?.projectType === "studio");
  useContextKey("inZenMode", tasksMode === "zen");
  useContextKey("inBlitzMode", tasksMode === "blitz");

  // Allow any page's "help" button (e.g. Blitz toolbar) to open the same
  // overlay by dispatching a custom event instead of duplicating state.
  useEffect(() => {
    const open = () => setShowHelp(true);
    window.addEventListener("grove:open-help", open);
    return () => window.removeEventListener("grove:open-help", open);
  }, []);

  // Mobile virtual-keyboard tracker: exposes the keyboard height as a global
  // CSS variable (--grove-kb-inset). Bottom-anchored UI uses
  // `bottom: var(--grove-kb-inset, 0)` to lift above the keyboard on iOS.
  //
  // window.resize fires when the layout viewport changes — orientation
  // flip, iPad split-view resize, breakpoint crossing. On Android Chrome
  // (and older iOS) it ALSO fires when the keyboard opens, in undefined
  // order relative to vv.resize. Recompute from `vv` directly on every
  // event rather than blanking the var; this keeps the inset correct
  // when the keyboard is genuinely up at resize time, while still
  // letting orientation changes update the value.
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const root = document.documentElement;
    const recompute = () => {
      // The keyboard can only be up if a text field is focused. In a
      // standalone PWA (viewport-fit=cover) `innerHeight - vv.height` is a
      // non-zero *static* difference even with the keyboard closed — counting
      // that as a keyboard inset leaves bottom-anchored UI (the chat composer)
      // floating well above the bottom, with a large empty gap. Gate on focus
      // so a closed keyboard always yields 0.
      const ae = document.activeElement as HTMLElement | null;
      const editing =
        !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
      const offset = window.innerHeight - vv.height - vv.offsetTop;
      root.style.setProperty("--grove-kb-inset", `${editing && offset > 50 ? offset : 0}px`);
    };
    vv.addEventListener("resize", recompute);
    vv.addEventListener("scroll", recompute);
    window.addEventListener("resize", recompute);
    // Recompute on focus changes so the inset drops to 0 the moment the
    // composer blurs (keyboard dismissed), even if no viewport event fires.
    window.addEventListener("focusin", recompute);
    window.addEventListener("focusout", recompute);
    recompute();
    return () => {
      vv.removeEventListener("resize", recompute);
      vv.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("focusin", recompute);
      window.removeEventListener("focusout", recompute);
      root.style.removeProperty("--grove-kb-inset");
    };
  }, []);

  // Tag the document when running as an installed/standalone PWA so the app
  // shell can use `100vh` instead of `100dvh`. On iOS standalone (viewport-fit
  // =cover) `100dvh` resolves to the screen height MINUS the top safe-area
  // inset, leaving an unfilled strip at the physical bottom; `100vh` is the
  // true full screen there. Browser tabs keep `100dvh` (where `100vh` would
  // overshoot behind the URL bar). Covers both the standard media query and
  // iOS's legacy `navigator.standalone`.
  useEffect(() => {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    document.documentElement.classList.toggle("grove-standalone", !!standalone);
  }, []);

  useEffect(() => {
    return registerGlobalShortcut(
      globalConfig?.web?.show_hide_window_shortcut || "",
      (event) => {
        if (event.state === "Pressed") {
          invoke("toggle_main_window_visibility").catch((err) => {
            console.error("Failed to toggle Grove window:", err);
          });
        }
      },
      "window",
    );
  }, [globalConfig?.web?.show_hide_window_shortcut]);

  // Menubar popover global shortcut — parallel to the main window one.
  // Conflict guard: if the same combo is bound to the main window we
  // skip registration (Tauri's global-shortcut plugin would error
  // anyway; this just keeps the log noise actionable).
  useEffect(() => {
    const shortcut = globalConfig?.notifications?.menubar_shortcut || "";
    const mainShortcut = globalConfig?.web?.show_hide_window_shortcut || "";
    if (shortcut && shortcut === mainShortcut) {
      console.warn(
        "[shortcut] menubar_shortcut conflicts with show_hide_window_shortcut — skipping registration",
      );
      return;
    }
    return registerGlobalShortcut(
      shortcut,
      (event) => {
        if (event.state === "Pressed") {
          invoke("toggle_tray_popover_visibility").catch((err) => {
            console.error("Failed to toggle Grove menubar:", err);
          });
        }
      },
      "menubar",
    );
  }, [
    globalConfig?.notifications?.menubar_shortcut,
    globalConfig?.web?.show_hide_window_shortcut,
  ]);

  const handleSwitchToZen = useCallback(() => {
    setTasksMode("zen");
    refreshProjects();
    refreshSelectedProject();
  }, [refreshProjects, refreshSelectedProject]);

  const navigateToProjectDashboard = useCallback(() => {
    setActiveItem("dashboard");
    setNavigationData(null);
  }, []);

  // Restore the last view the user was on for a given project. Falls back to
  // "dashboard" if nothing is recorded. We don't validate the saved view
  // against the project's nav set — renderContent handles unknown views by
  // falling through to its "coming soon" placeholder, but in practice the
  // sidebar won't navigate to a view that isn't in the current nav set.
  const navigateToProjectLastView = useCallback(
    (projectId: string) => {
      const saved = readLastProjectView(projectId);
      if (saved) {
        setActiveItem(saved);
        setNavigationData(null);
      } else {
        navigateToProjectDashboard();
      }
    },
    [navigateToProjectDashboard],
  );

  // Persist the current top-level view per project. Sub-state (selected
  // taskId / chatId / sketch tab) is restored by per-(project,task)
  // mechanisms like readLastActiveTab; this only covers the sidebar-level
  // page the user is on.
  useEffect(() => {
    if (!selectedProject) return;
    writeLastProjectView(selectedProject.id, activeItem);
  }, [selectedProject, activeItem]);

  // Initialize agent configuration on app startup
  useEffect(() => {
    const initializeAgentConfig = async () => {
      try {
        // Load current config + marketplace snapshot (single source of truth
        // for "what's launchable on this machine").
        const [cfg, marketplace] = await Promise.all([
          getConfig(),
          listMarketplace(),
        ]);

        // Refresh the global icon CDN map (bundled brand > CDN > Bot).
        setMarketplaceIcons(
          marketplace.agents.map((a) => ({ id: a.id, icon_url: a.icon_url })),
        );

        const launchable = marketplace.agents.filter(
          (a) =>
            (a.install_state === "grove-installed" ||
              a.install_state === "auto-detected") &&
            !(a.installed?.hidden ?? false),
        );
        const launchableIds = new Set(launchable.map((a) => a.id));
        const terminalIds = new Set(
          launchable
            .filter((a) => a.supports_terminal_launch)
            .map((a) => a.id),
        );

        // Post-v2.6 migration, config.toml's agent_command values are
        // already canonical, so a direct set lookup is enough.
        const matches = (saved: string, set: Set<string>): boolean => set.has(saved);

        let needsUpdate = false;
        const updates: { layout?: { agent_command?: string }, acp?: { agent_command?: string } } = {};

        // Terminal agent fallback: only kicks in if user's chosen one isn't
        // installed terminal-capable any more.
        if (cfg.layout?.agent_command) {
          if (!matches(cfg.layout.agent_command, terminalIds)) {
            const firstAvailable = launchable.find((a) =>
              a.supports_terminal_launch,
            );
            if (firstAvailable) {
              updates.layout = { agent_command: firstAvailable.id };
              needsUpdate = true;
            }
          }
        }

        // Chat / ACP agent fallback: anything launchable is acp-capable.
        if (cfg.acp?.agent_command) {
          if (!matches(cfg.acp.agent_command, launchableIds)) {
            const firstAvailable = launchable[0];
            if (firstAvailable) {
              updates.acp = { agent_command: firstAvailable.id };
              needsUpdate = true;
            }
          }
        }

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
    }
    setIsAddingProject(false);
  };

  const handleCloneProject = async (url: string, name?: string) => {
    setIsAddingProject(true);
    setAddProjectError(null);
    try {
      const project = await cloneProject(url, name);
      selectProject(project);
      navigateToProjectDashboard();
      setShowAddProject(false);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "message" in err) {
        setAddProjectError((err as { message: string }).message || "Failed to clone project");
      } else {
        setAddProjectError("Failed to clone project");
      }
    }
    setIsAddingProject(false);
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
    }
    setIsAddingProject(false);
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

  // Auto-navigate when a project is auto-selected via currentProjectId.
  // Restore the user's last view for that project, or fall back to the
  // dashboard if they've never visited it. Uses the documented
  // "Adjusting state on prop change" pattern (compare to a memoised marker
  // stored in state) so we don't setState inside an effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [autoNavigatedFor, setAutoNavigatedFor] = useState<string | null>(null);
  if (
    currentProjectId &&
    selectedProject &&
    !hasExitedWelcome &&
    autoNavigatedFor !== currentProjectId
  ) {
    setAutoNavigatedFor(currentProjectId);
    setHasExitedWelcome(true);
    const saved = readLastProjectView(currentProjectId);
    setActiveItem(saved ?? "dashboard");
  }

  // Tray popover navigation. Rust emits `tray:navigate` with a route and
  // optional project/task/chat ids. Listener is registered ONCE; refs
  // hold the latest projects + selectProject so re-mounts don't drop
  // events arriving in the gap.
  const projectsRef = useRef(projects);
  const selectProjectRef = useRef(selectProject);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  useEffect(() => {
    selectProjectRef.current = selectProject;
  }, [selectProject]);
  useEffect(() => {
    // Apply a tray:navigate payload to local nav state. Used from both the
    // event listener and the initial drain of any pending event the Rust
    // side stashed before `listen()` resolved.
    type NavigatePayload = {
      route: string;
      project_id?: string | null;
      task_id?: string | null;
      chat_id?: string | null;
    };
    const allowedRoutes = new Set<string>([
      ...REPO_NAV_IDS,
      ...STUDIO_NAV_IDS,
      "settings",
      "projects",
    ]);
    const applyNavigate = (p: NavigatePayload) => {
      console.log("[BlitzNav] applyNavigate (tray/Radio)", p, { tasksMode: tasksModeRef.current });
      const { route, project_id, task_id, chat_id } = p;
      const project = project_id
        ? projectsRef.current.find((pr) => pr.id === project_id)
        : undefined;
      if (project) selectProjectRef.current(project);
      setHasExitedWelcome(true);

      // For local tasks, navigate to "work" instead of "tasks".
      // Local tasks always have id "_local" (backend constant LOCAL_TASK_ID).
      // The projects list uses convertProjectListItem which sets localTask: null,
      // so we cannot rely on project.localTask here — check the id directly.
      // Skip the redirect in Blitz mode: BlitzPage shows local tasks in the
      // "Local" group and consumes the navigation data itself. Routing to
      // "work" would set navigationData=null and leave the notification
      // click with no visible effect.
      let effectiveRoute = route;
      if (task_id && route === "tasks" && tasksModeRef.current !== "blitz") {
        const task = project?.tasks?.find((t) => t.id === task_id);
        const isLocalTask =
          task?.isLocal || task_id === "_local";
        if (isLocalTask) {
          effectiveRoute = "work";
        }
      } else if (task_id && route === "tasks" && task_id === "_local") {
        console.log("[BlitzNav] applyNavigate: Blitz mode, skipping local-task→work redirect");
      }

      // Guard against typos / future nav-id renames so the tray can't
      // silently put the user on a page that doesn't exist.
      setActiveItem(allowedRoutes.has(effectiveRoute) ? effectiveRoute : "dashboard");
      if (task_id && effectiveRoute !== "work") {
        // viewMode "terminal" makes TasksPage drop into Workspace mode
        // (chat / terminal panes) — what the user expects when clicking
        // Open from the tray.
        // projectId is plumbed in for the Blitz consumer: the local task
        // always has id "_local", so a project-less lookup would
        // ambiguous-match the first local task in the project list and
        // route the user to the wrong project. Same flow for
        // handleNavigate (notification) — its data already carries
        // projectId from NotificationPopover.
        console.log("[BlitzNav] applyNavigate: setNavigationData", { taskId: task_id, projectId: project_id, chatId: chat_id, viewMode: "terminal" });
        setNavigationData({
          taskId: task_id,
          projectId: project_id ?? undefined,
          chatId: chat_id ?? undefined,
          viewMode: "terminal",
        });
      } else {
        setNavigationData(null);
        // Work route bypasses TasksPage entirely, so the chat-switch handoff
        // that TasksPage normally performs has to be planted here instead.
        // Otherwise WorkPage's TaskChat mounts and useInitialChatLoad falls
        // back to readLastActiveTab — i.e. tray click lands on whichever
        // chat the user last opened, ignoring the tray's chat_id.
        if (task_id && effectiveRoute === "work" && chat_id && project_id) {
          (window as unknown as Record<string, unknown>).__grove_pending_chat = {
            projectId: project_id,
            taskId: task_id,
            chatId: chat_id,
          };
          window.dispatchEvent(
            new CustomEvent("grove:switch-chat", {
              detail: { projectId: project_id, taskId: task_id, chatId: chat_id },
            }),
          );
        }
      }
    };

    // 1. Drain any tray:navigate that Rust stashed before this listener
    //    was alive (covers the async-listen race).
    invoke<NavigatePayload | null>("tray_take_pending_navigate")
      .then((p) => {
        if (p) applyNavigate(p);
      })
      .catch(() => {
        /* not running in Tauri or command unavailable — silently skip */
      });

    // 2. Subscribe for live events. StrictMode-safe: cancellation flag so
    //    a teardown during the async registration doesn't leak the
    //    listener.
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;
    listen<NavigatePayload>("tray:navigate", (e) => applyNavigate(e.payload))
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch((err) => console.warn("[tray:navigate] listen failed:", err));
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);


  const handleNavigate = (page: string, data?: Record<string, unknown>) => {
    console.log("[BlitzNav] handleNavigate (notification)", { page, data, tasksMode });
    let targetProject = selectedProject;
    if (data?.projectId) {
      const found = projects.find((p) => p.id === data.projectId);
      if (found) {
        selectProject(found);
        targetProject = found;
      }
    }
    // Redirect local tasks to "work" page.
    // Local tasks always have id "_local" (backend constant LOCAL_TASK_ID).
    // targetProject may come from the minimal project list (localTask: null),
    // so checking the id directly is the reliable fallback.
    let effectivePage = page;
    if (page === "tasks" && data?.taskId) {
      const task = targetProject?.tasks?.find((t) => t.id === data.taskId);
      const isLocalTask =
        task?.isLocal ||
        data.taskId === "_local";
      if (isLocalTask) effectivePage = "work";
    }
    setActiveItem(effectivePage);
    console.log("[BlitzNav] handleNavigate: setNavigationData", { effectivePage, data });
    setNavigationData(data ?? null);
  };

  // When project changes via sidebar ProjectSelector, restore the user's
  // last view for that project (falls back to dashboard if the saved view
  // isn't valid for the new project type).
  const handleProjectSwitch = useCallback(
    (newProjectId?: string) => {
      const targetId = newProjectId ?? selectedProject?.id ?? null;
      if (targetId) {
        navigateToProjectLastView(targetId);
      } else {
        navigateToProjectDashboard();
      }
    },
    [navigateToProjectLastView, navigateToProjectDashboard, selectedProject?.id],
  );

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

  // ─── Global command wiring (catalog handlers) ─────────────────────────
  // These mirror the catalog: every id below has a matching CommandDef in
  // src/keyboard/catalog/. The catalog owns the keybinding + scope + when
  // expression — we just provide the handler. Keep these grouped by
  // category to match the catalog files.

  // Navigation
  useCommand("nav.dashboard", () => setActiveItem("dashboard"), []);
  useCommand("nav.work", () => setActiveItem("work"), []);
  useCommand("nav.tasks", () => setActiveItem("tasks"), []);
  useCommand("nav.tasks.studio", () => setActiveItem("tasks"), []);
  useCommand("nav.resource", () => setActiveItem("resource"), []);
  useCommand("nav.automation", () => setActiveItem("automation"), []);
  useCommand("nav.skills", () => setActiveItem("skills"), []);
  useCommand("nav.ai", () => setActiveItem("ai"), []);
  useCommand("nav.statistics", () => setActiveItem("statistics"), []);
  useCommand("nav.settings", () => setActiveItem("settings"), []);
  useCommand("nav.projects", () => setActiveItem("projects"), []);
  // nav.sidebar.collapse removed — view.sidebar.toggle is the SSoT.
  useCommand("nav.cycle.next", () => navigateSidebar(1, true), [navigateSidebar]);
  useCommand("nav.cycle.previous", () => navigateSidebar(-1, true), [navigateSidebar]);

  // Native window controls (Tauri GUI only; no-op in the browser Web IDE,
  // gated by `enabled: isTauriShell` so they don't surface as dead commands).
  const isTauriShell =
    typeof window !== "undefined" &&
    !!(
      (window as Window & { __TAURI__?: unknown }).__TAURI__ ||
      (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    );
  const runWindowAction = useCallback(
    async (action: "minimize" | "maximizeToggle" | "fullscreenToggle" | "close") => {
      try {
        const mod = await import("@tauri-apps/api/window");
        const win = mod.getCurrentWindow();
        if (action === "minimize") await win.minimize();
        else if (action === "maximizeToggle") await win.toggleMaximize();
        else if (action === "fullscreenToggle")
          await win.setFullscreen(!(await win.isFullscreen()));
        else if (action === "close") await win.close();
      } catch (e) {
        console.error("[window] action failed:", e);
      }
    },
    [],
  );
  useCommand("window.minimize", () => void runWindowAction("minimize"), { enabled: () => isTauriShell }, [runWindowAction, isTauriShell]);
  useCommand("window.maximize.toggle", () => void runWindowAction("maximizeToggle"), { enabled: () => isTauriShell }, [runWindowAction, isTauriShell]);
  useCommand("window.fullscreen.toggle", () => void runWindowAction("fullscreenToggle"), { enabled: () => isTauriShell }, [runWindowAction, isTauriShell]);
  useCommand("window.close", () => void runWindowAction("close"), { enabled: () => isTauriShell }, [runWindowAction, isTauriShell]);

  // Project
  useCommand("project.add", () => {
    setAddProjectInitialMode("coding");
    setShowAddProject(true);
  }, []);
  // Cmd+P toggles the project palette (press again to close); other palettes
  // close automatically via the context's mutual exclusion.
  useCommand("project.switch", () => toggleProjectPalette(), [toggleProjectPalette]);
  useCommand(
    "project.refresh",
    () => {
      refreshProjects();
      refreshSelectedProject();
    },
    [refreshProjects, refreshSelectedProject],
  );
  useCommand(
    "project.openIDE",
    () => {
      if (selectedProject) openIDE(selectedProject.id);
    },
    { enabled: () => !!selectedProject },
    [selectedProject],
  );
  useCommand(
    "project.openTerminal",
    () => {
      if (selectedProject) openTerminal(selectedProject.id);
    },
    { enabled: () => !!selectedProject },
    [selectedProject],
  );

  // View — sidebar toggle, zoom, density
  useCommand("view.sidebar.toggle", () => setSidebarCollapsed((v) => !v), []);

  const setZoom = useCallback((z: number) => {
    if (typeof document === "undefined") return;
    const clamped = Math.max(0.5, Math.min(2, z));
    (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(clamped);
    try {
      window.localStorage.setItem("grove:view.zoom", String(clamped));
    } catch {
      /* ignore */
    }
  }, []);
  const getZoom = useCallback(() => {
    if (typeof document === "undefined") return 1;
    const raw = (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom;
    const n = raw ? parseFloat(raw) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
  }, []);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("grove:view.zoom");
      if (saved) setZoom(parseFloat(saved));
    } catch {
      /* ignore */
    }
  }, [setZoom]);
  useCommand("view.zoom.increase", () => setZoom(getZoom() + 0.1), [setZoom, getZoom]);
  useCommand("view.zoom.decrease", () => setZoom(getZoom() - 0.1), [setZoom, getZoom]);
  useCommand("view.zoom.reset", () => setZoom(1), [setZoom]);

  const setDensity = useCallback((value: "compact" | "cozy" | "spacious") => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-density", value);
    }
    try {
      window.localStorage.setItem("grove:view.density", value);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("grove:view.density");
      if (saved === "compact" || saved === "cozy" || saved === "spacious") {
        document.documentElement.setAttribute("data-density", saved);
      }
    } catch {
      /* ignore */
    }
  }, []);
  useCommand("view.density.compact", () => setDensity("compact"), [setDensity]);
  useCommand("view.density.cozy", () => setDensity("cozy"), [setDensity]);
  useCommand("view.density.spacious", () => setDensity("spacious"), [setDensity]);

  // Mode — theme + zen/blitz
  useCommand(
    "mode.theme.toggle",
    () => {
      const next = themeMode === "dark" ? "light" : "dark";
      void setAppearance({ mode: next });
    },
    [themeMode, setAppearance],
  );
  useCommand(
    "mode.zen.activate",
    () => setTasksMode("zen"),
    { enabled: () => tasksMode !== "zen" },
    [tasksMode],
  );
  useCommand(
    "mode.blitz.activate",
    () => setTasksMode("blitz"),
    { enabled: () => tasksMode !== "blitz" },
    [tasksMode],
  );

  // Help / Settings
  useCommand("help.toggle", () => setShowHelp((v) => !v), []);
  useCommand("help.openShortcutSettings", () => {
    setActiveItem("settings");
    // SettingsPage scrolls to #shortcuts on mount if the hash is present.
    setTimeout(() => {
      window.location.hash = "#shortcuts";
    }, 50);
  }, []);
  // settings.open removed — nav.settings is now the SSoT and owns Mod+,.
  useCommand(
    "settings.close",
    () => setActiveItem("dashboard"),
    { enabled: () => activeItem === "settings" },
    [activeItem],
  );

  // Palette close — open variants are wired via useCommandPalette elsewhere
  useCommand("palette.project.close", () => closeProjectPalette(), [closeProjectPalette]);
  useCommand("palette.task.close", () => closeTaskPalette(), [closeTaskPalette]);
  // Cmd+T toggles the task palette (was previously unhandled — a dead key).
  useCommand("palette.task.open", () => toggleTaskPalette(), [toggleTaskPalette]);
  // Cmd+K toggles the search/command palette (press again to close).
  useCommand("palette.legacy.command.open", () => toggleCommandPalette(), [toggleCommandPalette]);

  // Debug
  useCommand("debug.reload", () => window.location.reload(), []);
  useCommand(
    "debug.logState",
    () => {
      console.log("[grove] selectedProject:", selectedProject);
      console.log("[grove] activeItem:", activeItem);
      console.log("[grove] themeMode:", themeMode);
      console.log("[grove] tasksMode:", tasksMode);
    },
    [selectedProject, activeItem, themeMode, tasksMode],
  );
  useCommand("debug.commandRegistry.list", () => {
    const all = commandRegistry.listCommands();
    console.table(
      all.map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        scope: c.scope ?? "(global)",
        bindings: (c.defaultBindings ?? []).map((b) => b.key).join(", "),
      })),
    );
    console.log(`[grove] ${all.length} commands registered`);
  }, []);

  // agent.new.default / agent.picker.show — dispatch events TaskChat
  // listens for. Catalog scopes both to `workspace`, so they only fire
  // while a TaskChat is mounted. No per-agent commands: custom and
  // marketplace-installed agents can't be predeclared in the catalog,
  // so a generic "default" + "picker" pair covers everyone uniformly.
  useCommand(
    "agent.new.default",
    () => {
      window.dispatchEvent(new CustomEvent("grove:new-session-default-agent"));
    },
    [],
  );
  useCommand(
    "agent.picker.show",
    () => {
      window.dispatchEvent(new CustomEvent("grove:show-agent-picker"));
    },
    [],
  );

  // F12 / Cmd+Alt+I — toggle Tauri devtools. Routes through the catalog
  // so the binding is rebindable in Settings; the actual platform call
  // is a Tauri command (no-op in a regular browser).
  useCommand(
    "debug.devtools.toggle",
    () => {
      const w = window as Window & { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };
      void w.__TAURI_INTERNALS__?.invoke("toggle_devtools").catch(() => {});
    },
    [],
  );

  // Register global command builder — uses refs internally, no re-renders
  const globalOptionsRef = useRef<UseCommandsOptions>(null!);
  const nextGlobalOptions: UseCommandsOptions = {
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

  // Sync the latest options into the ref after render so the registered
  // command builder always sees fresh values. Effect-only ref write avoids
  // mutating refs during render.
  useEffect(() => {
    globalOptionsRef.current = nextGlobalOptions;
  });

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
      case "automation":
        return (
          <AutomationPage
            onOpenChat={(taskId, chatId) => {
              // Mirror the tray's deep-link handoff (this same file,
              // `handleNavigate` around line 552). Two paths exist:
              //
              //   • Tasks route → setNavigationData({taskId, chatId}).
              //     TasksPage consumes it and itself dispatches
              //     grove:switch-chat once mounted.
              //   • Work route (Local Task) → TasksPage isn't on the
              //     path at all, so we must plant `__grove_pending_chat`
              //     on window before mount. WorkPage's TaskChat reads
              //     this on init; without it useInitialChatLoad falls
              //     back to readLastActiveTab and our chatId is ignored.
              const projectId = selectedProject?.id;
              if (!projectId) return;
              const isLocal = taskId === "_local";
              if (isLocal) {
                (window as unknown as Record<string, unknown>).__grove_pending_chat = {
                  projectId,
                  taskId,
                  chatId,
                };
                setActiveItem("work");
                window.dispatchEvent(
                  new CustomEvent("grove:switch-chat", {
                    detail: { projectId, taskId, chatId },
                  }),
                );
              } else {
                setActiveItem("tasks");
                setNavigationData({ taskId, chatId });
              }
            }}
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
      default: {
        // Plugin sidebar page (`contributes.sidebar`) — app-scoped full page.
        if (activeItem.startsWith("plugin:")) {
          const pluginId = activeItem.slice("plugin:".length);
          const plugin = sidebarPlugins.find((p) => p.id === pluginId);
          if (plugin) {
            return <PluginFrame plugin={plugin} projectId={selectedProject?.id ?? null} />;
          }
        }
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
    }
  };

  const isDashboardPage = activeItem === "dashboard";
  const isFullWidthPage =
    isDashboardPage ||
    activeItem === "projects" ||
    activeItem === "work" ||
    activeItem === "skills" ||
    activeItem === "ai" ||
    activeItem === "resource" ||
    activeItem === "automation" ||
    activeItem === "statistics" ||
    activeItem.startsWith("plugin:");

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
    sidebarPlugins,
  };

  // Add-library dialog — surfaces both the install confirmation and any
  // download/parse/install error so the user always knows what happened.
  // Rendered in both desktop and mobile branches via {addLibraryDialog}.
  let addLibraryDialog: React.ReactNode = null;
  if (addLibrary.state?.kind === "install") {
    const s = addLibrary.state;
    const unnamedCount = s.total - s.namedCount;
    addLibraryDialog = (
      <ConfirmDialog
        isOpen
        title="Add Excalidraw library"
        variant="warning"
        confirmLabel={`Install ${s.total} item${s.total === 1 ? "" : "s"}`}
        cancelLabel="Cancel"
        onConfirm={addLibrary.confirm}
        onCancel={addLibrary.dismiss}
        message={
          <div className="space-y-2">
            <p>
              Install <strong>{s.total}</strong> item{s.total === 1 ? "" : "s"}{" "}
              into your global Excalidraw library from:
            </p>
            <p className="font-mono text-xs break-all text-[var(--color-text)]/80">
              {s.url}
            </p>
            <div className="text-xs space-y-1">
              <div>
                <span className="text-[var(--color-text-muted)]">
                  With name (usable by AI):
                </span>{" "}
                <strong>{s.namedCount}</strong>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">
                  Without name (canvas-only, AI cannot reference):
                </span>{" "}
                <strong
                  className={unnamedCount > 0 ? "text-[var(--color-warning)]" : ""}
                >
                  {unnamedCount}
                </strong>
              </div>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              Only accept libraries from sources you trust.
            </p>
          </div>
        }
      />
    );
  } else if (addLibrary.state?.kind === "error") {
    const s = addLibrary.state;
    addLibraryDialog = (
      <ConfirmDialog
        isOpen
        title="Add Excalidraw library failed"
        variant="danger"
        confirmLabel={s.retryable ? "Reload to retry" : "OK"}
        cancelLabel="Dismiss"
        onConfirm={() => {
          if (s.retryable) {
            window.location.reload();
          } else {
            addLibrary.dismiss();
          }
        }}
        onCancel={addLibrary.dismiss}
        message={
          <div className="space-y-2">
            <p>{s.message}</p>
            <p className="font-mono text-xs break-all text-[var(--color-text-muted)]">
              {s.url}
            </p>
            {s.retryable && (
              <p className="text-xs text-[var(--color-text-muted)]">
                The pending install is parked for an hour — you can refresh
                this page to retry without re-clicking the source link.
              </p>
            )}
          </div>
        }
      />
    );
  }

  // Mobile layout
  if (isMobile) {
    return (
      <div className="grove-app-shell flex flex-col bg-[var(--color-bg)] overflow-hidden pt-[env(safe-area-inset-top)]">
        <UpdateBanner />
        <MobileHeader
          onMenuOpen={() => setDrawerOpen(true)}
          onNotificationOpen={() => setMobileNotifOpen(true)}
        />
        <NotificationPopover
          isOpen={mobileNotifOpen}
          onClose={() => setMobileNotifOpen(false)}
          onNavigate={handleNavigate}
        />
        <MobileDrawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <Sidebar
            {...sidebarProps}
            drawerMode
            onDrawerClose={() => setDrawerOpen(false)}
          />
        </MobileDrawer>

        <main className={`relative min-h-0 flex-1 ${(activeItem === "tasks" && tasksMode !== "blitz") || activeItem === "work" ? "overflow-hidden" : "overflow-y-auto"}`}>
          {/* TasksPage always mounted on mobile too */}
          <div
            className="h-full p-3"
            style={{ display: activeItem === "tasks" && tasksMode !== "blitz" ? "block" : "none" }}
          >
            <TasksPage
              pageVisible={activeItem === "tasks" && tasksMode !== "blitz"}
              initialTaskId={tasksMode === "blitz" ? undefined : navigationData?.taskId as string | undefined}
              initialChatId={tasksMode === "blitz" ? undefined : navigationData?.chatId as string | undefined}
              initialViewMode={tasksMode === "blitz" ? undefined : navigationData?.viewMode as string | undefined}
              initialOpenNewTask={tasksMode === "blitz" ? undefined : navigationData?.openNewTask as boolean | undefined}
              onNavigationConsumed={() => setNavigationData(null)}
              onNavByIndex={navigateSidebar}
              exitWorkspaceSignal={tasksExitSignal}
            />
          </div>
          <div className={activeItem === "work" ? "h-full p-3" : isFullWidthPage ? "min-h-full p-3" : "max-w-5xl mx-auto p-3"}
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
                  <BlitzPage
                    onSwitchToZen={handleSwitchToZen}
                    onNavigate={setActiveItem}
                    initialTaskId={navigationData?.taskId as string | undefined}
                    initialProjectId={navigationData?.projectId as string | undefined}
                    initialChatId={navigationData?.chatId as string | undefined}
                    initialViewMode={navigationData?.viewMode as string | undefined}
                    onNavigationConsumed={() => setNavigationData(null)}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="zen-content"
                  className={activeItem === "work" ? "w-full h-full" : "w-full min-h-full"}
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
          onClone={handleCloneProject}
          isLoading={isAddingProject}
          externalError={addProjectError}
          initialMode={addProjectInitialMode}
        />
        <CommandPalette />
        <ActionCommandPalette />
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
        {addLibraryDialog}
      </div>
    );
  }

  // Desktop layout (unchanged)
  return (
    <div className="flex h-screen bg-[var(--color-bg)] overflow-hidden">
      {/* Invisible top-edge drag strip — Tauri Overlay title-bar mode hides
          the OS title bar, so the user expects to drag the window from
          anywhere along the top edge (Raycast / Tahoe convention).
          h-6 = 24px matches main's `p-6` top padding so the strip never
          covers actual card content. z-[45] sits above the sidebar (z-40)
          but below modals/popovers (z-50+).

          ⚠ Z-INDEX CONTRACT: any clickable UI placed in the top 24px must
          use z-50 or higher, otherwise this drag strip will swallow its
          mousedown events.

          data-tauri-drag-region: gives us double-click-maximize for free.
          data-window-drag-strip: picked up by the document-level mousedown
            listener in the parent useEffect to trigger startDragging(). */}
      <div
        className="fixed top-0 left-0 right-0 h-6 z-[45]"
        data-tauri-drag-region
        data-window-drag-strip
      />
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
            <BlitzPage
              onSwitchToZen={handleSwitchToZen}
              onNavigate={setActiveItem}
              initialTaskId={navigationData?.taskId as string | undefined}
              initialProjectId={navigationData?.projectId as string | undefined}
              initialChatId={navigationData?.chatId as string | undefined}
              initialViewMode={navigationData?.viewMode as string | undefined}
              onNavigationConsumed={() => setNavigationData(null)}
            />
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
            <div data-grove-sidebar><Sidebar {...sidebarProps} /></div>
            {/* Floating main card — mirrors the sidebar's "floating panel"
               language so the chrome reads as a single design system:
               two cards on a desktop, 12px gap between them and to all
               window edges. left tracks the sidebar collapsed state so
               the gap stays visually consistent in both modes. */}
            <main
              className={`fixed top-3 right-3 bottom-3 rounded-2xl bg-[var(--color-bg)] transition-[left] duration-200 ease-in-out ${isFullWidthPage && !isDashboardPage ? "overflow-hidden" : "overflow-y-auto"}`}
              style={{
                left: effectiveSidebarCollapsed ? "96px" : "280px",
                boxShadow:
                  "0 1px 3px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06), 0 0 0 1px color-mix(in oklab, var(--color-border) 35%, transparent)",
              }}
            >
              {/* TasksPage always mounted to preserve workspace state across tab switches */}
              <div
                className={`h-full transition-[padding] duration-300 ease-out ${inWorkspace ? 'p-2' : 'p-6'}`}
                style={{ display: activeItem === "tasks" ? "block" : "none" }}
              >
                <TasksPage
                  pageVisible={activeItem === "tasks"}
                  initialTaskId={navigationData?.taskId as string | undefined}
                  initialChatId={navigationData?.chatId as string | undefined}
                  initialViewMode={navigationData?.viewMode as string | undefined}
                  initialOpenNewTask={navigationData?.openNewTask as boolean | undefined}
                  onNavigationConsumed={() => setNavigationData(null)}
                  onNavByIndex={navigateSidebar}
                  exitWorkspaceSignal={tasksExitSignal}
                />
              </div>
              {activeItem !== "tasks" && (
                <div className={isFullWidthPage ? `h-full transition-[padding] duration-300 ease-out ${activeItem === "work" ? 'p-2' : 'p-6'}` : "max-w-5xl mx-auto p-6"}>
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
        onClone={handleCloneProject}
        isLoading={isAddingProject}
        externalError={addProjectError}
        initialMode={addProjectInitialMode}
      />
      <CommandPalette />
      <ActionCommandPalette />
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
      {addLibraryDialog}
    </div>
  );
}

function App() {
  // Check for /review/{projectId}/{taskId} path — render diff review directly
  const reviewMatch = window.location.pathname.match(/^\/review\/([^/]+)\/([^/]+)/);
  if (reviewMatch) {
    return (
      <ThemeProvider>
        <BannerProvider>
          <PreviewCommentProvider>
            <DiffReviewPage projectId={reviewMatch[1]} taskId={reviewMatch[2]} />
          </PreviewCommentProvider>
        </BannerProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <BannerProvider>
        <AuthGate>
          <ConfigProvider>
            <TerminalThemeProvider>
              <ProjectProvider>
                <NotificationProvider>
                  <CommandPaletteProvider>
                    <PreviewCommentProvider>
                      <OptionalPerfProfiler id="App">
                        <AppContent />
                      </OptionalPerfProfiler>
                    </PreviewCommentProvider>
                  </CommandPaletteProvider>
                </NotificationProvider>
              </ProjectProvider>
            </TerminalThemeProvider>
          </ConfigProvider>
        </AuthGate>
      </BannerProvider>
    </ThemeProvider>
  );
}

export default App;
