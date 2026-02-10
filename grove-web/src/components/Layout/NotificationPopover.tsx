import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Info, AlertTriangle, AlertCircle } from "lucide-react";
import { useNotifications } from "../../context";
import type { HookEntryResponse } from "../../api/hooks";

interface NotificationPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
}

function formatTimeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1d ago";
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function getLevelIcon(level: string) {
  switch (level) {
    case "critical":
      return <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: "var(--color-error)" }} />;
    case "warn":
      return <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: "var(--color-warning)" }} />;
    default:
      return <Info className="w-4 h-4 flex-shrink-0" style={{ color: "var(--color-info)" }} />;
  }
}

function NotificationItem({
  notification,
  onDismiss,
  onClick,
}: {
  notification: HookEntryResponse;
  onDismiss: () => void;
  onClick: () => void;
}) {
  return (
    <div
      className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--color-bg-secondary)] transition-colors cursor-pointer"
      onClick={onClick}
    >
      {getLevelIcon(notification.level)}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-text)] truncate">
            {notification.task_name}
          </span>
          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">
            {formatTimeAgo(notification.timestamp)}
          </span>
        </div>
        <div className="text-xs text-[var(--color-text-muted)] truncate">
          {notification.project_name}
        </div>
        {notification.message && (
          <div className="text-xs text-[var(--color-text)] mt-1 line-clamp-2">
            {notification.message}
          </div>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="flex-shrink-0 p-1 rounded hover:bg-[var(--color-bg-tertiary)] transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function NotificationPopover({ isOpen, onClose, onNavigate }: NotificationPopoverProps) {
  const { notifications, dismissNotification } = useNotifications();
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleMouseDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={popoverRef}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.15 }}
          className="fixed z-50 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-xl"
          style={{
            left: 72,
            bottom: 80,
            width: 360,
            maxHeight: 480,
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
            <span className="text-sm font-semibold text-[var(--color-text)]">
              Notifications
            </span>
            <span className="text-xs text-[var(--color-text-muted)]">
              {notifications.length > 0 ? `${notifications.length} active` : ""}
            </span>
          </div>

          {/* List */}
          <div className="overflow-y-auto" style={{ maxHeight: 400 }}>
            {notifications.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
                No notifications
              </div>
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {notifications.map((n) => (
                  <NotificationItem
                    key={`${n.project_id}-${n.task_id}`}
                    notification={n}
                    onDismiss={() => dismissNotification(n.project_id, n.task_id)}
                    onClick={() => {
                      dismissNotification(n.project_id, n.task_id);
                      onNavigate?.("tasks", { taskId: n.task_id, projectId: n.project_id, viewMode: "terminal" });
                      onClose();
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
