import { Bell } from "lucide-react";
import { useProject, useNotifications } from "../../context";

interface MobileHeaderProps {
  onMenuOpen: () => void;
  onNotificationOpen: () => void;
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

export function MacOSSidebarIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* outer rounded rect */}
      <rect x="2.5" y="3" width="19" height="18" rx="3" />
      {/* sidebar divider */}
      <line x1="9" y1="3" x2="9" y2="21" />
      {/* sidebar content indicator lines */}
      <line x1="4.5" y1="9" x2="7" y2="9" />
      <line x1="4.5" y1="12" x2="7" y2="12" />
      <line x1="4.5" y1="15" x2="7" y2="15" />
    </svg>
  );
}

export function MobileHeader({ onMenuOpen, onNotificationOpen }: MobileHeaderProps) {
  const { selectedProject } = useProject();
  const { unreadCount } = useNotifications();

  return (
    <header
      data-tauri-drag-region
      className={`flex items-center justify-between bg-[var(--color-bg)] border-b border-[var(--color-border)] flex-shrink-0 select-none ${
        shouldAvoidTrafficLights ? "h-[56px] pl-[80px] pr-4" : "h-12 px-4"
      }`}
    >
      <button
        onClick={onMenuOpen}
        className={`rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors ${
          shouldAvoidTrafficLights ? "p-2" : "p-2 -ml-2"
        }`}
        aria-label="Open menu"
      >
        <MacOSSidebarIcon className="w-5 h-5" />
      </button>

      <span className="text-sm font-medium text-[var(--color-text)] truncate mx-3 pointer-events-none">
        {selectedProject?.name || "Grove"}
      </span>

      <button
        onClick={onNotificationOpen}
        className={`relative rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors ${
          shouldAvoidTrafficLights ? "p-2" : "p-2 -mr-2"
        }`}
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
