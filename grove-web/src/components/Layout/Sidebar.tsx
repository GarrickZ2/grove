import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Settings,
  LayoutGrid,
  Laptop,
  ListTodo,
  Columns3,
  Blocks,
  Sparkles,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Bell,
  Search,
  Layers,
} from "lucide-react";
import { ProjectSelector } from "./ProjectSelector";
import { NotificationPopover } from "./NotificationPopover";
import { LogoBrand } from "./LogoBrand";
import { GroveIcon } from "./GroveIcon";
import { useNotifications, useProject } from "../../context";
import { REPO_NAV_IDS, STUDIO_NAV_IDS } from "../../data/nav";
import type { TasksMode } from "../../App";
import { Zap, Code } from "lucide-react";
import type { Task } from "../../data/types";

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
  boards: { id: "boards", label: "Boards", icon: Columns3, beta: true },
  resource: { id: "resource", label: "Studio", icon: Layers },
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
  collapsed: boolean;
  onToggleCollapse: () => void;
  onManageProjects?: (tab?: "coding" | "studio") => void;
  onAddProject?: (studioMode?: "studio") => void;
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
  tasksMode: TasksMode;
  onTasksModeChange: (mode: TasksMode) => void;
  onProjectSwitch?: () => void;
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
}

export function Sidebar({ activeItem, onItemClick, collapsed, onToggleCollapse, onManageProjects, onAddProject, onNavigate, tasksMode, onTasksModeChange, onProjectSwitch, onSearch, drawerMode, onDrawerClose, tasks, onTaskSelect, inWorkspace }: SidebarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const { unreadCount } = useNotifications();
  const { selectedProject } = useProject();
  const navItems = resolveNavItems(selectedProject?.projectType === "studio");

  const isCollapsed = drawerMode ? false : collapsed;

  const handleItemClick = (id: string) => {
    onItemClick(id);
    onDrawerClose?.();
  };

  const content = (
    <>
      {/* Logo + Mode Brand */}
      <div className="p-4 select-none">
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

      {/* Project Selector */}
      <div className="relative border-b border-[var(--color-border)]">
        <ProjectSelector collapsed={isCollapsed} onManageProjects={(tab) => { onManageProjects?.(tab); onDrawerClose?.(); }} onAddProject={(studioMode) => { onAddProject?.(studioMode); onDrawerClose?.(); }} onProjectSwitch={onProjectSwitch} />
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
      </nav>

      {/* Footer */}
      <div className="p-2 border-t border-[var(--color-border)] select-none">
        {/* Search / Command Palette */}
        {onSearch && (
          <motion.button
            whileHover={{ x: isCollapsed ? 0 : 2 }}
            whileTap={{ scale: 0.98 }}
            onClick={onSearch}
            title={isCollapsed ? "Search (⌘K)" : undefined}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150
              ${isCollapsed ? "justify-center" : ""}
              text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]`}
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
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150
              ${isCollapsed ? "justify-center" : ""}
              ${notifOpen
                ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
              }`}
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

          <NotificationPopover
            isOpen={notifOpen}
            onClose={() => setNotifOpen(false)}
            onNavigate={onNavigate}
          />
        </div>

        <NavButton
          item={{ id: "settings", label: "Settings", icon: Settings }}
          isActive={activeItem === "settings"}
          onClick={() => handleItemClick("settings")}
          collapsed={isCollapsed}
        />

        {/* Collapse Toggle — hidden in drawer mode */}
        {!drawerMode && (
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onToggleCollapse}
            className="w-full flex items-center justify-center gap-3 px-3 py-2.5 mt-1 rounded-xl text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
          >
            {collapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <>
                <ChevronLeft className="w-4 h-4" />
                <span className="flex-1 text-left">Collapse</span>
              </>
            )}
          </motion.button>
        )}
      </div>
    </>
  );

  // In drawer mode, content is rendered inside MobileDrawer — no wrapper needed
  if (drawerMode) {
    return <>{content}</>;
  }

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 72 : 256 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className="h-screen bg-[var(--color-bg)] border-r border-[var(--color-border)] flex flex-col flex-shrink-0 select-none"
    >
      {content}
    </motion.aside>
  );
}

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
      className="z-[9999] w-[260px] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden"
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
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150
        ${collapsed ? "justify-center" : ""}
        ${
          isActive
            ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
            : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
        }`}
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 flex items-center gap-1.5">
            <span>{item.label}</span>
            {item.beta && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-md bg-amber-500/15 text-amber-500 leading-none">
                beta
              </span>
            )}
          </span>
          {isActive && (
            <motion.div
              layoutId="activeIndicator"
              className="w-1.5 h-1.5 rounded-full bg-[var(--color-highlight)]"
            />
          )}
        </>
      )}
    </motion.button>
  );
}
