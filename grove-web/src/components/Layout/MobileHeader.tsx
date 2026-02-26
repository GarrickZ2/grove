import { Menu, Bell } from "lucide-react";
import { useProject, useNotifications } from "../../context";

interface MobileHeaderProps {
  onMenuOpen: () => void;
  onNotificationOpen: () => void;
}

export function MobileHeader({ onMenuOpen, onNotificationOpen }: MobileHeaderProps) {
  const { selectedProject } = useProject();
  const { unreadCount } = useNotifications();

  return (
    <header className="flex items-center justify-between px-4 h-12 bg-[var(--color-bg)] border-b border-[var(--color-border)] flex-shrink-0">
      <button
        onClick={onMenuOpen}
        className="p-2 -ml-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      <span className="text-sm font-medium text-[var(--color-text)] truncate mx-3">
        {selectedProject?.name || "Grove"}
      </span>

      <button
        onClick={onNotificationOpen}
        className="relative p-2 -mr-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-[16px] flex items-center justify-center px-0.5 text-[9px] font-bold text-white bg-red-500 rounded-full leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
    </header>
  );
}
