import { useState } from "react";
import { motion } from "framer-motion";
import {
  Settings,
  LayoutGrid,
  ListTodo,
  Blocks,
  ChevronLeft,
  ChevronRight,
  Bell,
} from "lucide-react";
import { ProjectSelector } from "./ProjectSelector";
import { NotificationPopover } from "./NotificationPopover";
import { LogoBrand } from "./LogoBrand";
import { GroveIcon } from "./GroveIcon";
import { useNotifications } from "../../context";
import type { TasksMode } from "../../App";

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
}

const navItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "skills", label: "Skills", icon: Blocks },
];

interface SidebarProps {
  activeItem: string;
  onItemClick: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onManageProjects: () => void;
  onAddProject?: () => void;
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
  tasksMode: TasksMode;
  onTasksModeChange: (mode: TasksMode) => void;
  onProjectSwitch?: () => void;
  /** When true, renders sidebar content without the outer motion.aside wrapper (for use inside MobileDrawer) */
  drawerMode?: boolean;
  /** Called when an item is clicked in drawer mode so the drawer can close */
  onDrawerClose?: () => void;
}

export function Sidebar({ activeItem, onItemClick, collapsed, onToggleCollapse, onManageProjects, onAddProject, onNavigate, tasksMode, onTasksModeChange, onProjectSwitch, drawerMode, onDrawerClose }: SidebarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const { unreadCount } = useNotifications();

  const isCollapsed = drawerMode ? false : collapsed;

  const handleItemClick = (id: string) => {
    onItemClick(id);
    onDrawerClose?.();
  };

  const content = (
    <>
      {/* Logo + Mode Brand */}
      <div className="p-4">
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
        <ProjectSelector collapsed={isCollapsed} onManageProjects={() => { onManageProjects(); onDrawerClose?.(); }} onAddProject={() => { onAddProject?.(); onDrawerClose?.(); }} onProjectSwitch={onProjectSwitch} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 overflow-y-auto">
        <div className="space-y-1">
          {navItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              isActive={activeItem === item.id}
              onClick={() => handleItemClick(item.id)}
              collapsed={isCollapsed}
            />
          ))}
        </div>
      </nav>

      {/* Footer */}
      <div className="p-2 border-t border-[var(--color-border)]">
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
      className="h-screen bg-[var(--color-bg)] border-r border-[var(--color-border)] flex flex-col flex-shrink-0"
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
          <span className="flex-1 text-left">{item.label}</span>
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
