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
}

export function Sidebar({ activeItem, onItemClick, collapsed, onToggleCollapse, onManageProjects, onAddProject, onNavigate, tasksMode, onTasksModeChange, onProjectSwitch }: SidebarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const { unreadCount } = useNotifications();

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 72 : 256 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className="h-screen bg-[var(--color-bg)] border-r border-[var(--color-border)] flex flex-col flex-shrink-0"
    >
      {/* Logo + Mode Brand */}
      <div className="p-4">
        {collapsed ? (
          <button
            onClick={() => onTasksModeChange(tasksMode === "zen" ? "blitz" : "zen")}
            className="flex items-center justify-center"
            title={`Switch to ${tasksMode === "zen" ? "Blitz" : "Zen"} mode`}
          >
            <img src="/logo.png" alt="Grove" className="w-10 h-10 rounded-xl" />
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
        <ProjectSelector collapsed={collapsed} onManageProjects={onManageProjects} onAddProject={onAddProject} onProjectSwitch={onProjectSwitch} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 overflow-y-auto">
        <div className="space-y-1">
          {navItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              isActive={activeItem === item.id}
              onClick={() => onItemClick(item.id)}
              collapsed={collapsed}
            />
          ))}
        </div>
      </nav>

      {/* Footer */}
      <div className="p-2 border-t border-[var(--color-border)]">
        {/* Notification Bell */}
        <div className="relative">
          <motion.button
            whileHover={{ x: collapsed ? 0 : 2 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setNotifOpen(!notifOpen)}
            title={collapsed ? "Notifications" : undefined}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150
              ${collapsed ? "justify-center" : ""}
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
            {!collapsed && <span className="flex-1 text-left">Notifications</span>}
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
          onClick={() => onItemClick("settings")}
          collapsed={collapsed}
        />

        {/* Collapse Toggle */}
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onToggleCollapse}
          className="w-full flex items-center justify-center gap-3 px-3 py-2.5 mt-1 rounded-lg text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
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
      </div>
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
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150
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
