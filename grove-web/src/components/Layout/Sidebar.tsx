import { useState, useRef, useEffect, useMemo, useCallback, createElement } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Settings,
  LayoutGrid,
  Laptop,
  ListTodo,
  Blocks,
  Sparkles,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Bell,
  Search,
  Layers,
  Repeat,
  Maximize2,
  PictureInPicture2,
  ChevronDown,
  X,
  Plus,
  Settings2,
} from "lucide-react";
import type { Plugin } from "../../api/plugins";
import { PluginIcon } from "../Plugins/PluginIcon";
import { ProjectSelector } from "./ProjectSelector";
import { NotificationPopover } from "./NotificationPopover";
import { formatTimeAgo, getLevelIcon } from "../../utils/notificationFormat";
import { LogoBrand } from "./LogoBrand";
import { GroveIcon } from "./GroveIcon";
import { useNotifications, useProject, useTheme } from "../../context";
import { getProjectStyle } from "../../utils/projectStyle";
import { filterProjectsByType } from "../../utils/projectFilter";
import { useCommand } from "../../keyboard";
import { useFirstTimeHint, useRadioEvents } from "../../hooks";
import { REPO_NAV_IDS, STUDIO_NAV_IDS } from "../../data/nav";
import type { TasksMode } from "../../App";
import { Zap, Code, Check } from "lucide-react";
import type { Task, Project } from "../../data/types";
import type { RadioEvent, NodeStatus } from "../../api/walkieTalkie";
import { apiClient } from "../../api/client";
import { labelFor, orderOptions } from "../../utils/permissionOptions";
import type { PermissionOption } from "../../utils/permissionOptions";
import { agentIconComponent } from "../../utils/agentIcon";

type SidebarMode = "expanded" | "collapsed" | "island";

// ── Dynamic Island live activity queue ──────────────────────────────────
//
// Driven by the same `chat_status` radio event the menubar tray uses
// (see TrayPopover.tsx), not the hook_added/NotificationLevel system.
// Only two transitions are "an alert": busy/permission → idle (a finished
// turn, with the agent's final `message`) and → permission_required (the
// agent is blocked waiting on a response). Everything else (busy itself,
// connecting) is just ambient status, not a queueable alert.
type LiveAlert =
  | {
      kind: "message";
      chatId: string;
      projectId: string;
      taskId: string;
      taskName: string;
      text: string;
      agent: string | null;
    }
  | {
      kind: "permission";
      chatId: string;
      projectId: string;
      taskId: string;
      taskName: string;
      description: string | null;
      options: PermissionOption[];
    };

type ChatStatusEvent = Extract<RadioEvent, { type: "chat_status" }>;

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  beta?: boolean;
}

const ALL_NAV_ITEMS: Record<string, NavItem> = {
  dashboard: { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
  work: { id: "work", label: "Work", icon: Laptop },
  tasks: { id: "tasks", label: "Tasks", icon: ListTodo },
  resource: { id: "resource", label: "Studio", icon: Layers },
  automation: { id: "automation", label: "Automation", icon: Repeat },
  skills: { id: "skills", label: "Skills", icon: Blocks },
  ai: { id: "ai", label: "AI", icon: Sparkles },
  statistics: { id: "statistics", label: "Statistics", icon: BarChart2 },
};

function resolveNavItems(isStudio: boolean): NavItem[] {
  const ids = isStudio ? STUDIO_NAV_IDS : REPO_NAV_IDS;
  return ids.map((id) => ALL_NAV_ITEMS[id]).filter(Boolean);
}

interface SidebarProps {
  activeItem: string;
  onItemClick: (id: string) => void;
  mode: SidebarMode;
  onSetMode: (mode: SidebarMode) => void;
  onManageProjects?: (tab?: "coding" | "studio") => void;
  onAddProject?: (studioMode?: "studio") => void;
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
  tasksMode: TasksMode;
  onTasksModeChange: (mode: TasksMode) => void;
  onProjectSwitch?: (projectId?: string) => void;
  /** Open command palette (⌘K) */
  onSearch?: () => void;
  /** When true, renders sidebar content without the outer motion.aside wrapper (for use inside MobileDrawer) */
  drawerMode?: boolean;
  /** Called when an item is clicked in drawer mode so the drawer can close */
  onDrawerClose?: () => void;
  /** Non-archived tasks for the current project (for Tasks button hover popup) */
  tasks?: Task[];
  /** Called when user selects a task from the hover popup */
  onTaskSelect?: (task: Task) => void;
  /** Whether a task workspace is currently active */
  inWorkspace?: boolean;
  /** Installed plugins contributing a top-level page (`contributes.sidebar`). */
  sidebarPlugins?: Plugin[];
}

const isTauri = typeof window !== "undefined" && (
  "__TAURI__" in window ||
  "__TAURI_INTERNALS__" in window
);

const isMac = typeof navigator !== "undefined" && (
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
  /Mac|iPhone|iPad/i.test(navigator.platform || "")
);

const shouldAvoidTrafficLights = isTauri && isMac;

export function Sidebar({
  activeItem,
  onItemClick,
  mode,
  onSetMode,
  onManageProjects,
  onAddProject,
  onNavigate,
  tasksMode,
  onTasksModeChange,
  onProjectSwitch,
  onSearch,
  drawerMode,
  onDrawerClose,
  tasks,
  onTaskSelect,
  inWorkspace,
  sidebarPlugins,
}: SidebarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const { unreadCount } = useNotifications();
  const { selectedProject } = useProject();
  const { theme } = useTheme();
  const navItems = useMemo(
    () => resolveNavItems(selectedProject?.projectType === "studio"),
    [selectedProject?.projectType]
  );

  // ── Dynamic Island (mode === "island") state ────────────────────────────
  const [islandHovered, setIslandHovered] = useState(false);
  // Hover detection is suppressed for the first ~500ms after entering island
  // mode. Without this, the spring animation from the expanded sidebar to
  // the pill position causes the cursor to repeatedly cross the moving
  // element's bounds, firing mouseEnter/Leave in rapid succession — the
  // user sees the pill "appear then immediately collapse". Once the pill
  // settles, hover detection kicks in.
  //
  // Ref (not state) because we only need a synchronous flag for the mouse
  // handlers to read; the rendered output only depends on `islandHovered`.
  // Using state would also trigger a needless extra render.
  const hoverEnabledRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const islandHint = useFirstTimeHint("sidebar.island.hoverHint", 2200);
  // Which content the expanded island pill shows — "nav" is the default
  // project/nav/actions row; "notifications" / "projects" morph the pill
  // itself into an in-place list (no separate floating popover/palette)
  // when the bell / project chip is clicked. Resets to "nav" whenever the
  // pill closes so it always reopens on the default view.
  const [islandView, setIslandView] = useState<"nav" | "notifications" | "projects">("nav");

  // Live-activity queue — see the `LiveAlert` type above. Only drains while
  // the island is resting (not hovered): hovering always shows the
  // user-driven nav/notifications/projects view instead, so incoming
  // events just pile up here silently and resume displaying the moment
  // the user's mouse leaves the pill.
  const [liveAlertQueue, setLiveAlertQueue] = useState<LiveAlert[]>([]);
  const liveAlert = liveAlertQueue[0] ?? null;
  // Separate from `islandHovered` — the pill's own onMouseEnter is a no-op
  // while an alert is showing (see `onIslandEnter`), so this is the only
  // signal that the user's cursor is over a message alert, used to pause
  // its auto-advance timer without swapping the pill over to nav view.
  const [alertHovered, setAlertHovered] = useState(false);
  // Tracks each chat's last-seen status so a `busy`/`permission_required`
  // → `idle` transition can be told apart from an `idle` that was already
  // idle (which isn't a new "finished" event).
  const chatStatusRef = useRef<Map<string, NodeStatus>>(new Map());

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!islandHovered) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIslandView("nav");
    }
  }, [islandHovered]);

  // Catalog → Sidebar wire for the notifications popover. Sidebar is
  // always mounted (drawer or desktop), so this handler is reachable
  // from any page.
  useCommand("nav.notifications.toggle", () => setNotifOpen((v) => !v), []);

  const isCollapsed = drawerMode ? false : mode === "collapsed";
  const isIsland = !drawerMode && mode === "island";

  useRadioEvents({
    onChatStatus: (projectId: string, taskId: string, chatId: string, status: NodeStatus, payload?: ChatStatusEvent) => {
      const prevStatus = chatStatusRef.current.get(chatId);
      chatStatusRef.current.set(chatId, status);

      // Live activity is an island-only affordance — expanded/collapsed
      // modes keep the existing bell unread-count behavior untouched.
      if (!isIsland) return;

      if (status === "disconnected") {
        setLiveAlertQueue((q) => q.filter((a) => a.chatId !== chatId));
        return;
      }

      // Permission got resolved through some other surface — the in-chat
      // panel, the desktop tray popover, a phone. Drop any queued/shown
      // permission card for this chat so the island doesn't keep asking
      // the user to respond to something already handled elsewhere.
      if (prevStatus === "permission_required" && status !== "permission_required") {
        setLiveAlertQueue((q) => q.filter((a) => !(a.chatId === chatId && a.kind === "permission")));
      }

      const taskName = payload?.task_name ?? taskId;

      if (status === "idle" && (prevStatus === "busy" || prevStatus === "permission_required")) {
        const next: LiveAlert = {
          kind: "message",
          chatId,
          projectId,
          taskId,
          taskName,
          text: payload?.message ?? `${taskName} finished`,
          agent: payload?.agent ?? null,
        };
        setLiveAlertQueue((q) => {
          // Same chat superseding its own not-yet-shown message — replace
          // in place rather than double-queueing a stale one behind it.
          const idx = q.findIndex((a) => a.chatId === chatId && a.kind === "message");
          if (idx === -1) return [...q, next];
          const copy = [...q];
          copy[idx] = next;
          return copy;
        });
        return;
      }

      if (status === "permission_required") {
        const next: LiveAlert = {
          kind: "permission",
          chatId,
          projectId,
          taskId,
          taskName,
          description: payload?.permission?.description ?? null,
          options: payload?.permission?.options ?? [],
        };
        setLiveAlertQueue((q) => {
          // Agent can re-emit permission_required mid-turn (plan_update) —
          // update the queued/shown card in place instead of duplicating.
          const idx = q.findIndex((a) => a.chatId === chatId && a.kind === "permission");
          if (idx === -1) return [...q, next];
          const copy = [...q];
          copy[idx] = next;
          return copy;
        });
      }
    },
  });

  useEffect(() => {
    if (!isIsland) {
      hoverEnabledRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIslandHovered(false);
      // Drop any queued live-activity alerts — they'd otherwise resurface
      // stale (possibly minutes/hours old) if the user leaves and later
      // re-enters island mode.
      setLiveAlertQueue([]);
      return;
    }
    // Wait for the spring settle before accepting hover events.
    hoverEnabledRef.current = false;
    const t = setTimeout(() => {
      hoverEnabledRef.current = true;
    }, 500);
    return () => clearTimeout(t);
  }, [isIsland]);

  const handleItemClick = (id: string) => {
    onItemClick(id);
    onDrawerClose?.();
  };

  // Toggle between expanded and collapsed — does NOT touch island.
  // The existing bottom-of-sidebar "Collapse" button keeps this scope.
  const handleToggleCollapse = () => {
    if (mode === "expanded") onSetMode("collapsed");
    else if (mode === "collapsed") onSetMode("expanded");
    // In island mode the collapse button is hidden, but if called, bounce back.
    else onSetMode("expanded");
  };

  // Archive toggle: from any non-island state → island; from island → expanded.
  const handleToggleIsland = () => {
    if (mode === "island") {
      onSetMode("expanded");
      setIslandHovered(false);
    } else {
      onSetMode("island");
    }
  };

  const onIslandEnter = useCallback(() => {
    if (!hoverEnabledRef.current) return;
    // A live-activity alert owns hover while it's showing (buttons need to
    // be reachable without the whole pill snapping over to the nav view
    // out from under the cursor) — see `alertHovered` / `IslandLiveAlert`.
    if (liveAlert) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setIslandHovered(true);
    islandHint.show();
  }, [islandHint, liveAlert]);

  const onIslandLeave = useCallback(() => {
    if (!hoverEnabledRef.current) return;
    // Longer leave delay once expanded — gives the user time to settle the
    // cursor inside the wide horizontal pill before it collapses. 300ms is
    // the resting default; the expanded state bumps to 500ms.
    const delay = islandHovered ? 500 : 300;
    hideTimerRef.current = setTimeout(() => setIslandHovered(false), delay);
  }, [islandHovered]);

  // Pop the front of the queue — called once a message alert's timer
  // expires, or a permission alert is resolved/ignored.
  const advanceLiveAlertQueue = useCallback(() => {
    setLiveAlertQueue((q) => q.slice(1));
  }, []);

  // Message alerts auto-advance after 5s; permission alerts block until
  // resolved/ignored (no timer). Only runs while resting — hovering shows
  // the user-driven nav/notifications/projects view instead, which pauses
  // draining until the mouse leaves (see the cleanup/deps below).
  useEffect(() => {
    if (islandHovered || alertHovered) return;
    if (!liveAlert || liveAlert.kind !== "message") return;
    const t = setTimeout(advanceLiveAlertQueue, 5000);
    return () => clearTimeout(t);
  }, [liveAlert, islandHovered, alertHovered, advanceLiveAlertQueue]);

  const handleLiveAlertMessageClick = () => {
    if (!liveAlert || liveAlert.kind !== "message") return;
    onNavigate?.("tasks", {
      taskId: liveAlert.taskId,
      projectId: liveAlert.projectId,
      viewMode: "terminal",
      chatId: liveAlert.chatId,
    });
    advanceLiveAlertQueue();
  };

  const handleLiveAlertResolvePermission = (option: PermissionOption) => {
    if (!liveAlert || liveAlert.kind !== "permission") return;
    const { projectId, taskId, chatId } = liveAlert;
    apiClient
      .post("/api/v1/tray/resolve-permission", {
        projectId,
        taskId,
        chatId,
        optionId: option.option_id,
      })
      .catch((e) => console.error("[island] resolve permission failed", e));
    advanceLiveAlertQueue();
  };

  // ── Render: existing sidebar content (expanded / collapsed) ───────────
  const content = (
    <>
      {/* Logo + Mode Brand
         pt-8 reserves clearance for macOS traffic lights (Tauri Overlay
         title-bar mode). Drag is handled at the app root via a top strip
         in App.tsx, so this wrapper only needs the inner padding. */}
      <div
        className={`px-4 pb-4 select-none flex items-start gap-2 ${
          shouldAvoidTrafficLights && !drawerMode ? "pt-8" : "pt-4"
        }`}
      >
        <div className="flex-1 min-w-0">
          {isCollapsed ? (
            <button
              onClick={() => onTasksModeChange(tasksMode === "zen" ? "blitz" : "zen")}
              className="flex items-center justify-center"
              title={`Switch to ${tasksMode === "zen" ? "Blitz" : "Zen"} mode`}
            >
              <GroveIcon size={35} shimmer background className="rounded-xl" />
            </button>
          ) : (
            <LogoBrand
              mode={tasksMode}
              onToggle={() => onTasksModeChange(tasksMode === "zen" ? "blitz" : "zen")}
            />
          )}
        </div>

      </div>

      {/* Project Selector */}
      <div className="relative">
        <ProjectSelector
          collapsed={isCollapsed}
          onManageProjects={(tab) => { onManageProjects?.(tab); onDrawerClose?.(); }}
          onAddProject={(studioMode) => { onAddProject?.(studioMode); onDrawerClose?.(); }}
          onProjectSwitch={onProjectSwitch}
        />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 overflow-y-auto select-none">
        <div className="space-y-1">
          {navItems.map((item) => {
            const isTasksItem = item.id === "tasks";
            const hasPopup =
              isTasksItem &&
              activeItem === "tasks" &&
              !!inWorkspace &&
              !!tasks &&
              !!onTaskSelect &&
              tasks.filter((t) => t.status !== "archived").length > 0;

            if (hasPopup) {
              return (
                <TasksNavButtonWithPopup
                  key={item.id}
                  item={item}
                  isActive={activeItem === item.id}
                  onClick={() => handleItemClick(item.id)}
                  collapsed={isCollapsed}
                  tasks={tasks!}
                  onTaskSelect={onTaskSelect!}
                />
              );
            }

            return (
              <NavButton
                key={item.id}
                item={item}
                isActive={activeItem === item.id}
                onClick={() => handleItemClick(item.id)}
                collapsed={isCollapsed}
              />
            );
          })}
        </div>

        {/* Plugin pages (`contributes.sidebar`) — id namespaced `plugin:<id>`. */}
        {sidebarPlugins && sidebarPlugins.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-[var(--color-border)] pt-2">
            {sidebarPlugins.map((p) => {
              const navId = `plugin:${p.id}`;
              const Icon = (props: { className?: string }) => (
                <PluginIcon plugin={p} className={props.className} size={20} />
              );
              return (
                <NavButton
                  key={navId}
                  item={{ id: navId, label: p.contributes?.sidebar?.title || p.name, icon: Icon }}
                  isActive={activeItem === navId}
                  onClick={() => handleItemClick(navId)}
                  collapsed={isCollapsed}
                />
              );
            })}
          </div>
        )}
      </nav>

      {/* Footer */}
      <div className="p-2 select-none">
        {/* Search / Command Palette */}
        {onSearch && (
          <motion.button
            whileHover={{ x: isCollapsed ? 0 : 2 }}
            whileTap={{ scale: 0.98 }}
            onClick={onSearch}
            title={isCollapsed ? "Search (⌘K)" : undefined}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150
              ${isCollapsed ? "justify-center" : ""}
              text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]`}
          >
            <Search className="w-5 h-5 flex-shrink-0" />
            {!isCollapsed && (
              <span className="flex items-center gap-2">
                <span>Search</span>
                <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] leading-none">⌘K</kbd>
              </span>
            )}
          </motion.button>
        )}

        {/* Notification Bell */}
        <div className="relative">
          <motion.button
            whileHover={{ x: isCollapsed ? 0 : 2 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setNotifOpen(!notifOpen)}
            title={isCollapsed ? "Notifications" : undefined}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors duration-150
              ${isCollapsed ? "justify-center" : ""}
              ${notifOpen
                ? "font-semibold text-[var(--color-highlight)]"
                : "font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]"
              }`}
            style={
              notifOpen
                ? {
                    backgroundColor: "color-mix(in oklab, var(--color-highlight) 18%, transparent)",
                    boxShadow:
                      "0 1px 2px rgba(0, 0, 0, 0.05), inset 0 0 0 1px color-mix(in oklab, var(--color-highlight) 28%, transparent)",
                  }
                : undefined
            }
          >
            <div className="relative flex-shrink-0">
              <Bell className="w-5 h-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] flex items-center justify-center px-1 text-[10px] font-bold text-white bg-red-500 rounded-full leading-none">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </div>
            {!isCollapsed && <span className="flex-1 text-left">Notifications</span>}
          </motion.button>
        </div>

        <NavButton
          item={{ id: "settings", label: "Settings", icon: Settings }}
          isActive={activeItem === "settings"}
          onClick={() => handleItemClick("settings")}
          collapsed={isCollapsed}
        />

        {/* Sidebar-mode toggles — Collapse and Dynamic Island stacked as two
            full-width, labeled rows so Island reads as a named feature
            instead of an unlabeled icon nobody recognizes. */}
        {!drawerMode && (
          <div className="flex flex-col gap-1 mt-1">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleToggleCollapse}
              className="w-full flex items-center justify-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
            >
              {isCollapsed ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <>
                  <ChevronLeft className="w-4 h-4" />
                  <span className="flex-1 text-left">Collapse</span>
                </>
              )}
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleToggleIsland}
              title="Archive sidebar to Dynamic Island — Mod+."
              aria-label="Archive sidebar to Dynamic Island"
              className="w-full flex items-center justify-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
            >
              <PictureInPicture2 className="w-4 h-4" />
              {!isCollapsed && <span className="flex-1 text-left">Dynamic Island</span>}
            </motion.button>
          </div>
        )}
      </div>
    </>
  );

  // Hoisted out of `content` so `notifOpen` (toggled from the regular
  // sidebar's bell button) still renders when `content` isn't mounted.
  // Island mode never sets `notifOpen` — it morphs the pill itself into
  // an in-place notification view instead (see `islandView` above).
  const notificationPopover = (
    <NotificationPopover
      isOpen={notifOpen}
      onClose={() => setNotifOpen(false)}
      onNavigate={onNavigate}
    />
  );

  // In drawer mode, content is rendered inside MobileDrawer — no wrapper needed
  if (drawerMode) {
    return <>{content}{notificationPopover}</>;
  }

  // ── Desktop: animated wrapper with three-state morphing ────────────────
  // Width / height / position all animate together via spring. Single DOM
  // node, no FLIP — keeps the morph buttery and avoids layout jumps.
  //
  // Resting: 120×16 — slim chip, just thick enough to read as interactive.
  // Expanded (nav view): 720×64 — wide horizontal menu, full nav width.
  // Expanded (notifications view): narrower + taller — the pill morphs into
  // an in-place notification list instead of popping a separate floating
  // card, so it needs list height rather than menu width.
  const isNotificationsView = islandHovered && islandView === "notifications";
  const isProjectsView = islandHovered && islandView === "projects";
  const isWideExpandedView = isNotificationsView || isProjectsView;
  // Live-activity alerts only ever show while resting (not hovered) — see
  // the `liveAlertQueue` drain effect above. "message" is a single-line
  // toast; "permission" needs room for a description + two rows of buttons.
  const isMessageAlert = !islandHovered && liveAlert?.kind === "message";
  const isPermissionAlert = !islandHovered && liveAlert?.kind === "permission";
  const islandW = islandHovered
    ? (isWideExpandedView ? 400 : 720)
    : isMessageAlert
      ? 380
      : isPermissionAlert
        ? 480
        : 120;
  const islandH = islandHovered
    ? (isWideExpandedView ? 420 : 64)
    : isMessageAlert
      ? 60
      : isPermissionAlert
        ? 190
        : 16;

  return (
    <>
    <motion.aside
      initial={false}
      animate={{
        width: isIsland ? islandW : (mode === "collapsed" ? 72 : 256),
        height: isIsland ? islandH : "auto",
        top: isIsland ? 20 : 12,
        left: isIsland ? "50%" : 12,
        right: isIsland ? "auto" : "auto",
        bottom: isIsland ? "auto" : 12,
        x: isIsland ? "-50%" : "0%",
        y: 0,
        borderRadius: isIsland ? (islandHovered || isMessageAlert || isPermissionAlert ? 24 : 18) : 16,
      }}
      transition={{
        type: "spring",
        stiffness: 380,
        damping: 32,
        mass: 0.9,
      }}
      onMouseEnter={isIsland ? onIslandEnter : undefined}
      onMouseLeave={isIsland ? onIslandLeave : undefined}
      className={`fixed ${isIsland ? "z-50" : "z-40"} flex select-none ${
        isIsland
          ? `glass-island overflow-visible ${theme.isLight ? "glass-island-light" : ""} ${islandHovered || liveAlert ? "" : "glass-island-resting"}`
          : "glass-panel rounded-2xl flex-col overflow-visible"
      }`}
      style={{
        // When in island mode, keep the existing `flex-col` semantics from
        // the wider sidebar so the inner island-expanded row can render
        // horizontally without conflicting with parent flex direction.
        flexDirection: isIsland ? "row" : "column",
      }}
    >
      {isIsland ? (
        islandHovered ? (
          isNotificationsView ? (
            <IslandNotifications
              onBack={() => setIslandView("nav")}
              onNavigate={onNavigate}
            />
          ) : isProjectsView ? (
            <IslandProjectSwitcher
              onBack={() => setIslandView("nav")}
              onProjectSwitch={onProjectSwitch}
              onManageProjects={onManageProjects}
              onAddProject={onAddProject}
              accentPalette={theme.accentPalette}
            />
          ) : (
            <IslandExpanded
              activeItem={activeItem}
              onItemClick={onItemClick}
              navItems={navItems}
              sidebarPlugins={sidebarPlugins}
              selectedProjectName={selectedProject?.name ?? "No project"}
              selectedProjectStyle={selectedProject ? getProjectStyle(selectedProject.id, theme.accentPalette) : null}
              unreadCount={unreadCount}
              onOpenSearch={() => { onSearch?.(); setIslandHovered(false); }}
              onOpenNotifications={() => setIslandView("notifications")}
              onOpenProjectPalette={() => setIslandView("projects")}
              onOpenSettings={() => onItemClick("settings")}
              onRestoreSidebar={handleToggleIsland}
              hintVisible={islandHint.visible}
              onDismissHint={islandHint.dismiss}
            />
          )
        ) : liveAlert ? (
          <IslandLiveAlert
            alert={liveAlert}
            onMessageClick={handleLiveAlertMessageClick}
            onDismissMessage={advanceLiveAlertQueue}
            onResolvePermission={handleLiveAlertResolvePermission}
            onIgnorePermission={advanceLiveAlertQueue}
            onMouseEnter={() => setAlertHovered(true)}
            onMouseLeave={() => setAlertHovered(false)}
          />
        ) : (
          // Invisible hover pad — extends the resting pill's hit area.
          // The visual pill is 120×16 (very small target). Adding a 240×32
          // transparent pad centered below it doubles the width and gives
          // a 16px vertical buffer, so the user's cursor doesn't have to
          // land pixel-perfect on the thin black bar to trigger expand.
          // Removed the instant the pill expands — the expanded 720×64
          // surface is large enough to catch movement on its own.
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              width: 240,
              height: 32,
              pointerEvents: "auto",
            }}
          />
        )
      ) : (
        content
      )}
    </motion.aside>
    {notificationPopover}
    </>
  );
}

// ── Island expanded content ─────────────────────────────────────────────
//
// The wide horizontal pill shown when the user hovers over the resting
// island. Three columns:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [project] │ nav items (scrollable horizontal) │ search · bell · settings │
//   └──────────────────────────────────────────────────────────────┘
//
// Why this layout:
//   - Left anchor gives users a stable "where am I" cue (the project).
//     Clicking it opens the global project palette instead of the inline
//     picker — keeps island mode's interactions simple and consistent.
//   - Middle is the nav strip, scrollable horizontally so adding nav
//     items or plugin entries never pushes the right column off-screen.
//   - Right column is global actions (⌘K, notifications, settings, restore).
//     Active nav state is signaled by a 2px underline under the icon —
//     minimal, no text labels (matches Dynamic Island aesthetics).

interface IslandExpandedProps {
  activeItem: string;
  onItemClick: (id: string) => void;
  navItems: NavItem[];
  sidebarPlugins?: Plugin[];
  selectedProjectName: string;
  selectedProjectStyle: ReturnType<typeof getProjectStyle> | null;
  unreadCount: number;
  onOpenSearch: () => void;
  onOpenNotifications: () => void;
  onOpenProjectPalette: () => void;
  onOpenSettings: () => void;
  onRestoreSidebar: () => void;
  hintVisible: boolean;
  onDismissHint: () => void;
}

function IslandExpanded({
  activeItem,
  onItemClick,
  navItems,
  sidebarPlugins,
  selectedProjectName,
  selectedProjectStyle,
  unreadCount,
  onOpenSearch,
  onOpenNotifications,
  onOpenProjectPalette,
  onOpenSettings,
  onRestoreSidebar,
  hintVisible,
  onDismissHint,
}: IslandExpandedProps) {
  // Build the combined nav list including plugin entries
  const allNavIds = useMemo(() => {
    const ids = navItems.map((n) => n.id);
    if (sidebarPlugins) {
      for (const p of sidebarPlugins) {
        ids.push(`plugin:${p.id}`);
      }
    }
    return ids;
  }, [navItems, sidebarPlugins]);

  return (
    <div className="relative w-full h-full flex items-center px-3 gap-2">
      {/* Left column — project anchor */}
      <button
        onClick={onOpenProjectPalette}
        title={`${selectedProjectName} — click to switch`}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[color-mix(in_oklab,currentColor_85%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors flex-shrink-0 max-w-[160px]"
      >
        {selectedProjectStyle ? (
          <div
            className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: selectedProjectStyle.color.bg }}
          >
            <selectedProjectStyle.Icon className="w-3.5 h-3.5" style={{ color: selectedProjectStyle.color.fg }} />
          </div>
        ) : (
          <div className="w-6 h-6 rounded bg-[color-mix(in_oklab,currentColor_15%,transparent)] flex-shrink-0" />
        )}
        <span className="text-[13px] font-medium truncate">{selectedProjectName}</span>
        <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0" />
      </button>

      {/* Divider */}
      <span className="w-px h-5 bg-[color-mix(in_oklab,currentColor_10%,transparent)] flex-shrink-0" aria-hidden />

      {/* Middle column — horizontal nav */}
      <div className="flex-1 min-w-0 overflow-x-auto scrollbar-none">
        <div className="flex items-center gap-1 px-1">
          {navItems.map((item) => {
            const isActive = activeItem === item.id;
            return (
              <IslandNavButton
                key={item.id}
                icon={<item.icon className="w-4 h-4" />}
                label={item.label}
                isActive={isActive}
                onClick={() => onItemClick(item.id)}
              />
            );
          })}
          {sidebarPlugins?.map((p) => {
            const navId = `plugin:${p.id}`;
            const isActive = activeItem === navId;
            return (
              <IslandNavButton
                key={navId}
                icon={<PluginIcon plugin={p} size={16} />}
                label={p.contributes?.sidebar?.title || p.name}
                isActive={isActive}
                onClick={() => onItemClick(navId)}
              />
            );
          })}
          {/* Keep at least one tab in DOM even when the only nav item is
              active so the scroll-snap / overflow indicator stays stable */}
          {allNavIds.length === 0 && (
            <span className="text-[12px] text-[color-mix(in_oklab,currentColor_40%,transparent)] px-2">No pages</span>
          )}
        </div>
      </div>

      {/* Divider */}
      <span className="w-px h-5 bg-[color-mix(in_oklab,currentColor_10%,transparent)] flex-shrink-0" aria-hidden />

      {/* Right column — global actions */}
      <div className="flex items-center gap-0.5 flex-shrink-0 pr-1">
        <IslandIconButton
          onClick={onOpenSearch}
          title="Search (⌘K)"
          ariaLabel="Open search"
        >
          <Search className="w-4 h-4" />
          <span className="text-[10px] font-mono opacity-50 ml-0.5">⌘K</span>
        </IslandIconButton>
        <IslandIconButton
          onClick={onOpenNotifications}
          title="Notifications"
          ariaLabel="Open notifications"
          badge={unreadCount > 0 ? (unreadCount > 9 ? "9+" : String(unreadCount)) : undefined}
        >
          <Bell className="w-4 h-4" />
        </IslandIconButton>
        <IslandIconButton
          onClick={onOpenSettings}
          title="Settings"
          ariaLabel="Open settings"
        >
          <Settings className="w-4 h-4" />
        </IslandIconButton>
        <span className="w-px h-5 bg-[color-mix(in_oklab,currentColor_10%,transparent)] flex-shrink-0 mx-0.5" aria-hidden />
        <IslandIconButton
          onClick={onRestoreSidebar}
          title="Restore sidebar"
          ariaLabel="Restore sidebar"
        >
          <Maximize2 className="w-4 h-4" />
        </IslandIconButton>
      </div>

      {/* First-time hover hint — small floating chip BELOW the pill.
          (Previously above with -top-9, but the resting pill is only 28px
          tall — the chip would render off-screen above y:0. Below is also
          semantically right: the chip is the consequence of the pill
          expanding, not a label sitting on top of it.) */}
      <AnimatePresence>
        {hintVisible && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            onClick={onDismissHint}
            className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2.5 py-1 rounded-full bg-[var(--color-text)] text-[11px] font-medium text-[var(--color-bg)] shadow-lg cursor-pointer whitespace-nowrap"
          >
            Hover to expand · click outside to collapse
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface IslandNavButtonProps {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

function IslandNavButton({ icon, label, isActive, onClick }: IslandNavButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={isActive ? "page" : undefined}
      className={`relative flex flex-col items-center justify-center px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 ${
        isActive
          ? "text-current"
          : "text-[color-mix(in_oklab,currentColor_60%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_8%,transparent)]"
      }`}
    >
      {icon}
      {isActive && (
        <motion.span
          layoutId="island-nav-underline"
          className="absolute bottom-0.5 left-3 right-3 h-0.5 rounded-full bg-current"
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
        />
      )}
    </button>
  );
}

interface IslandIconButtonProps {
  onClick: () => void;
  title: string;
  ariaLabel: string;
  badge?: string;
  children: React.ReactNode;
}

function IslandIconButton({ onClick, title, ariaLabel, badge, children }: IslandIconButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className="relative flex items-center px-2 py-1.5 rounded-lg text-[color-mix(in_oklab,currentColor_70%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors"
    >
      {children}
      {badge && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center px-0.5 text-[9px] font-bold text-white bg-red-500 rounded-full leading-none">
          {badge}
        </span>
      )}
    </button>
  );
}

// ── Island notifications view ───────────────────────────────────────────
//
// Shown in place of `IslandExpanded` when the bell is clicked — the pill
// itself morphs into a notification list instead of popping a separate
// floating card, matching the "one surface that reshapes" Dynamic Island
// metaphor. Reuses the same data/behavior as the sidebar's regular
// `NotificationPopover` (useNotifications, dismiss, navigate, time
// formatting) — only the row styling differs, since the popover's rows are
// tuned for a light glass card and would lose contrast on this dark pill.

interface IslandNotificationsProps {
  onBack: () => void;
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
}

function IslandNotifications({ onBack, onNavigate }: IslandNotificationsProps) {
  const { notifications, dismissNotification, clearAllNotifications } = useNotifications();

  return (
    <div className="relative w-full h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0 border-b border-[color-mix(in_oklab,currentColor_10%,transparent)]">
        <button
          onClick={onBack}
          title="Back"
          aria-label="Back"
          className="flex items-center justify-center p-1.5 rounded-lg text-[color-mix(in_oklab,currentColor_70%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors flex-shrink-0"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-[13px] font-medium flex-1">Notifications</span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[color-mix(in_oklab,currentColor_50%,transparent)] flex-shrink-0">
            {notifications.length > 0 ? `${notifications.length} active` : ""}
          </span>
          {notifications.length > 0 && (
            <button
              type="button"
              onClick={() => void clearAllNotifications()}
              className="text-[10px] font-medium text-[color-mix(in_oklab,currentColor_50%,transparent)] hover:text-current transition-colors"
              aria-label="Clear all notifications"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto island-notifications-scroll">
        {notifications.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-[color-mix(in_oklab,currentColor_50%,transparent)]">
            No notifications
          </div>
        ) : (
          <div className="divide-y divide-[color-mix(in_oklab,currentColor_8%,transparent)]">
            {notifications.map((n) => (
              <div
                key={`${n.project_id}-${n.task_id}`}
                className="flex items-start gap-3 px-3 py-2.5 hover:bg-[color-mix(in_oklab,currentColor_6%,transparent)] transition-colors cursor-pointer"
                onClick={() => {
                  dismissNotification(n.project_id, n.task_id);
                  onNavigate?.("tasks", {
                    taskId: n.task_id,
                    projectId: n.project_id,
                    viewMode: "terminal",
                    ...(n.chat_id ? { chatId: n.chat_id } : {}),
                  });
                  onBack();
                }}
              >
                {getLevelIcon(n.level)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium truncate">{n.task_name}</span>
                    <span className="text-[10px] text-[color-mix(in_oklab,currentColor_50%,transparent)] whitespace-nowrap">
                      {formatTimeAgo(n.timestamp)}
                    </span>
                  </div>
                  <div className="text-[11px] text-[color-mix(in_oklab,currentColor_50%,transparent)] truncate">
                    {n.project_name}
                  </div>
                  {n.message && (
                    <div className="text-[11px] mt-0.5 line-clamp-2 text-[color-mix(in_oklab,currentColor_80%,transparent)]">
                      {n.message}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissNotification(n.project_id, n.task_id);
                  }}
                  className="flex-shrink-0 p-1 rounded text-[color-mix(in_oklab,currentColor_50%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Island project switcher view ────────────────────────────────────────
//
// Shown in place of `IslandExpanded` when the project chip is clicked —
// same "pill morphs in place" treatment as `IslandNotifications`, instead
// of popping the separate `ProjectSelector` dropdown. Reuses the same
// data (useProject, filterProjectsByType, getProjectStyle) and switch
// behavior as `ProjectSelector`; only the row/search styling is a new dark
// variant tuned for this pill instead of the light glass-popover.

interface IslandProjectSwitcherProps {
  onBack: () => void;
  onProjectSwitch?: (projectId?: string) => void;
  onManageProjects?: (tab?: "coding" | "studio") => void;
  onAddProject?: (studioMode?: "studio") => void;
  accentPalette: string[];
}

function IslandProjectSwitcher({
  onBack,
  onProjectSwitch,
  onManageProjects,
  onAddProject,
  accentPalette,
}: IslandProjectSwitcherProps) {
  const { selectedProject, projects, selectProject } = useProject();
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"coding" | "studio">("coding");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const filteredProjects = useMemo(() => {
    let list = filterProjectsByType(projects, typeFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [projects, searchQuery, typeFilter]);

  const handleSelectProject = (project: Project) => {
    const switched = selectedProject?.id !== project.id;
    selectProject(project);
    if (switched) onProjectSwitch?.(project.id);
    onBack();
  };

  return (
    <div className="relative w-full h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0 border-b border-[color-mix(in_oklab,currentColor_10%,transparent)]">
        <button
          onClick={onBack}
          title="Back"
          aria-label="Back"
          className="flex items-center justify-center p-1.5 rounded-lg text-[color-mix(in_oklab,currentColor_70%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors flex-shrink-0"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[color-mix(in_oklab,currentColor_8%,transparent)]">
          <Search className="w-3.5 h-3.5 text-[color-mix(in_oklab,currentColor_50%,transparent)] flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter projects..."
            className="flex-1 bg-transparent text-[12px] outline-none min-w-0 placeholder:text-[color-mix(in_oklab,currentColor_40%,transparent)]"
          />
        </div>
      </div>

      <div className="flex border-b border-[color-mix(in_oklab,currentColor_10%,transparent)] flex-shrink-0">
        {(["coding", "studio"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setTypeFilter(tab)}
            className={`flex-1 px-3 py-1.5 text-[11px] font-medium capitalize transition-colors ${
              typeFilter === tab
                ? "text-current border-b-2 border-current"
                : "text-[color-mix(in_oklab,currentColor_50%,transparent)] hover:text-current"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto island-notifications-scroll">
        {filteredProjects.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-[color-mix(in_oklab,currentColor_50%,transparent)]">
            No projects found
          </div>
        ) : (
          filteredProjects.map((project) => {
            const { color, Icon } = getProjectStyle(project.id, accentPalette);
            const isSelected = selectedProject?.id === project.id;
            const totalCount = project.taskCount ?? project.tasks.length;
            return (
              <button
                key={project.id}
                onClick={() => handleSelectProject(project)}
                title={project.name}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,currentColor_6%,transparent)] ${
                  isSelected ? "bg-[color-mix(in_oklab,currentColor_10%,transparent)]" : ""
                }`}
              >
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: color.bg }}
                >
                  <Icon className="w-3.5 h-3.5" style={{ color: color.fg }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium truncate">{project.name}</div>
                  <div className="text-[10px] text-[color-mix(in_oklab,currentColor_50%,transparent)]">
                    {totalCount} task{totalCount !== 1 ? "s" : ""}
                  </div>
                </div>
                {isSelected && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
              </button>
            );
          })
        )}
      </div>

      <div className="flex-shrink-0 border-t border-[color-mix(in_oklab,currentColor_10%,transparent)] p-1">
        <button
          onClick={() => {
            onAddProject?.(typeFilter === "studio" ? "studio" : undefined);
            onBack();
          }}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] text-[color-mix(in_oklab,currentColor_70%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Project</span>
        </button>
        <button
          onClick={() => {
            onManageProjects?.(typeFilter);
            onBack();
          }}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] text-[color-mix(in_oklab,currentColor_70%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors"
        >
          <Settings2 className="w-3.5 h-3.5" />
          <span>Manage Projects</span>
        </button>
      </div>
    </div>
  );
}

// ── Island live-activity alert ──────────────────────────────────────────
//
// Compact pill content shown while resting when the `liveAlertQueue` (see
// Sidebar's `LiveAlert` state) has something to show — mirrors iOS Dynamic
// Island's "Live Activity" for a chat_status transition. Two shapes:
//   - "message": single line, click-through navigates to the chat.
//   - "permission": description + up to 4 response buttons, laid out the
//     same way as the menubar tray's `PermissionCard` (primary CTA full
//     width, remaining options wrap below) — same visual language, just
//     re-themed for the dark pill via currentColor mixes.

interface IslandLiveAlertProps {
  alert: LiveAlert;
  onMessageClick: () => void;
  onDismissMessage: () => void;
  onResolvePermission: (option: PermissionOption) => void;
  onIgnorePermission: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function IslandLiveAlert({
  alert,
  onMessageClick,
  onDismissMessage,
  onResolvePermission,
  onIgnorePermission,
  onMouseEnter,
  onMouseLeave,
}: IslandLiveAlertProps) {
  if (alert.kind === "message") {
    return (
      <div
        onClick={onMessageClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        role="button"
        tabIndex={0}
        className="relative w-full h-full flex items-center gap-2.5 px-3 cursor-pointer"
      >
        {/* createElement avoids `react-hooks/static-components` flagging the
            dynamically-resolved component; agentIconComponent returns a
            stable reference per agent key, not a fresh one each render. */}
        {createElement(agentIconComponent(alert.agent), {
          className: "w-4 h-4 flex-shrink-0 text-[color-mix(in_oklab,currentColor_70%,transparent)]",
        })}
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium text-[color-mix(in_oklab,currentColor_60%,transparent)] truncate">
            {alert.taskName}
          </div>
          <div className="text-[12.5px] truncate">{alert.text}</div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismissMessage();
          }}
          title="Dismiss"
          aria-label="Dismiss"
          className="flex-shrink-0 p-1 rounded text-[color-mix(in_oklab,currentColor_50%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  const opts = orderOptions(alert.options);
  const primary = opts[0];
  const secondary = opts.slice(1);

  return (
    <div className="relative w-full h-full flex flex-col px-4 py-3 gap-2">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold truncate">{alert.taskName}</div>
        </div>
        <button
          onClick={onIgnorePermission}
          title="Ignore"
          aria-label="Ignore"
          className="flex-shrink-0 text-[11px] px-2 py-1 rounded text-[color-mix(in_oklab,currentColor_50%,transparent)] hover:text-current hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)] transition-colors"
        >
          Ignore
        </button>
      </div>
      {alert.description && (
        <div className="text-[12.5px] text-[color-mix(in_oklab,currentColor_75%,transparent)] line-clamp-3">
          {alert.description}
        </div>
      )}
      <div className="flex flex-col gap-1.5 mt-auto">
        {primary && (
          <button
            onClick={() => onResolvePermission(primary)}
            className="min-h-8 w-full rounded-lg px-3 py-1.5 text-[12.5px] font-medium leading-tight bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
          >
            {labelFor(primary)}
          </button>
        )}
        {secondary.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {secondary.map((opt) => {
              const isAllow = opt.kind.startsWith("allow");
              return (
                <button
                  key={opt.option_id}
                  onClick={() => onResolvePermission(opt)}
                  style={{ flex: "1 1 130px" }}
                  className={`min-h-8 min-w-0 max-w-full rounded-lg px-2.5 py-1.5 text-[11.5px] leading-tight text-center border transition-colors ${
                    isAllow
                      ? "border-[color-mix(in_oklab,currentColor_20%,transparent)] hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)]"
                      : "text-[var(--color-error)] border-[color-mix(in_srgb,var(--color-error)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)]"
                  }`}
                >
                  {labelFor(opt)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Existing helpers (preserved) ───────────────────────────────────────

interface NavButtonProps {
  item: NavItem;
  isActive: boolean;
  onClick: () => void;
  collapsed: boolean;
}

interface TasksNavButtonWithPopupProps {
  item: NavItem;
  isActive: boolean;
  onClick: () => void;
  collapsed: boolean;
  tasks: Task[];
  onTaskSelect: (task: Task) => void;
}

function TasksNavButtonWithPopup({ item, isActive, onClick, collapsed, tasks, onTaskSelect }: TasksNavButtonWithPopupProps) {
  const [hovered, setHovered] = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const updatePos = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPopupPos({ top: rect.top, left: rect.right + 8 });
    }
  };

  const handleMouseEnter = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    updatePos();
    setHovered(true);
  };

  const handleMouseLeave = () => {
    hideTimerRef.current = setTimeout(() => setHovered(false), 100);
  };

  const handleTaskClick = (task: Task) => {
    setHovered(false);
    onTaskSelect(task);
  };

  return (
    <div
      ref={btnRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <NavButton
        item={item}
        isActive={isActive}
        onClick={onClick}
        collapsed={collapsed}
      />
      <AnimatePresence>
        {hovered && popupPos && (
          <TasksHoverPopup
            tasks={tasks}
            onTaskSelect={handleTaskClick}
            top={popupPos.top}
            left={popupPos.left}
            onMouseEnter={() => {
              if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
            }}
            onMouseLeave={handleMouseLeave}
          />
        )}
      </AnimatePresence>
    </div>
  );
}


interface TasksHoverPopupProps {
  tasks: Task[];
  onTaskSelect: (task: Task) => void;
  top: number;
  left: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function TasksHoverPopup({ tasks, onTaskSelect, top, left, onMouseEnter, onMouseLeave }: TasksHoverPopupProps) {
  const nonArchived = tasks.filter((t) => t.status !== "archived");
  if (nonArchived.length === 0) return null;

  return createPortal(
    <motion.div
      initial={{ opacity: 0, x: -6, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -6, scale: 0.97 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      style={{ top, left, position: "fixed" }}
      className="glass-popover z-[9999] w-[260px] rounded-xl overflow-hidden"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Switch Task
        </span>
        <span className="text-[11px] text-[var(--color-text-muted)]">{nonArchived.length}</span>
      </div>

      {/* Task list */}
      <div className="max-h-[320px] overflow-y-auto py-1">
        {nonArchived.map((task) => {
          return (
            <motion.button
              key={task.id}
              whileHover={{ backgroundColor: "var(--color-bg-secondary)" }}
              onClick={() => onTaskSelect(task)}
              className="w-full text-left px-3 py-2.5 border-l-2 border-l-transparent hover:border-l-[var(--color-highlight)] transition-colors duration-100"
            >
              <div className="flex items-center gap-2.5">
                {/* Type icon */}
                <div className="flex-shrink-0">
                  {task.isLocal ? (
                    <Laptop className="w-3.5 h-3.5" style={{ color: "var(--color-accent)" }} />
                  ) : task.createdBy === "agent" ? (
                    <Zap className="w-3.5 h-3.5" style={{ color: "var(--color-info)" }} />
                  ) : (
                    <Code className="w-3.5 h-3.5" style={{ color: "var(--color-highlight)" }} />
                  )}
                </div>

                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-[var(--color-text)] truncate">{task.name}</span>
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>
    </motion.div>,
    document.body
  );
}

function NavButton({ item, isActive, onClick, collapsed }: NavButtonProps) {
  const Icon = item.icon;

  return (
    <motion.button
      whileHover={{ x: collapsed ? 0 : 2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors duration-150
        ${collapsed ? "justify-center" : ""}
        ${
          isActive
            ? "font-semibold text-[var(--color-highlight)]"
            : "font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]"
        }`}
      style={
        isActive
          ? {
              backgroundColor: "color-mix(in oklab, var(--color-highlight) 28%, transparent)",
              boxShadow:
                "0 2px 6px -1px color-mix(in oklab, var(--color-highlight) 25%, transparent), inset 0 0 0 1px color-mix(in oklab, var(--color-highlight) 45%, transparent)",
            }
          : undefined
      }
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      {!collapsed && (
        <span className="flex-1 flex items-center gap-1.5">
          <span>{item.label}</span>
          {item.beta && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-md bg-amber-500/15 text-amber-500 leading-none">
              beta
            </span>
          )}
        </span>
      )}
    </motion.button>
  );
}