import { motion } from "framer-motion";
import {
  Settings,
  LayoutGrid,
  ListTodo,
  ChevronLeft,
  ChevronRight,
  TreePine,
} from "lucide-react";
import { ProjectSelector } from "./ProjectSelector";

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
}

const navItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { id: "tasks", label: "Tasks", icon: ListTodo },
];

interface SidebarProps {
  activeItem: string;
  onItemClick: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onManageProjects: () => void;
  onLogoClick?: () => void;
}

export function Sidebar({ activeItem, onItemClick, collapsed, onToggleCollapse, onManageProjects, onLogoClick }: SidebarProps) {
  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 72 : 256 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className="h-screen bg-[var(--color-bg)] border-r border-[var(--color-border)] flex flex-col flex-shrink-0"
    >
      {/* Logo */}
      <div className="p-4">
        <button
          onClick={onLogoClick}
          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          title="Back to Welcome"
        >
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--color-highlight)] to-[var(--color-accent)] flex items-center justify-center flex-shrink-0">
            <TreePine className="w-5 h-5 text-white" strokeWidth={2} />
          </div>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-lg font-bold bg-gradient-to-r from-[var(--color-highlight)] to-[var(--color-accent)] bg-clip-text text-transparent"
            >
              GROVE
            </motion.span>
          )}
        </button>
      </div>

      {/* Project Selector */}
      <div className="relative border-b border-[var(--color-border)]">
        <ProjectSelector collapsed={collapsed} onManageProjects={onManageProjects} />
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
