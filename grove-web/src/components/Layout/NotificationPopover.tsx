import { useEffect, useRef, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useNotifications } from "../../context";
import { useIsMobile } from "../../hooks";
import type { HookEntryResponse } from "../../api/hooks";
import { formatTimeAgo, getLevelIcon } from "../../utils/notificationFormat";

interface NotificationPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
  /** Desktop anchor override — defaults to the bottom-left sidebar position. */
  anchorStyle?: CSSProperties;
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

export function NotificationPopover({ isOpen, onClose, onNavigate, anchorStyle }: NotificationPopoverProps) {
  const { notifications, dismissNotification, clearAllNotifications } = useNotifications();
  const popoverRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useIsMobile();

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
        <>
          {/* Mobile backdrop */}
          {isMobile && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={onClose}
              className="fixed inset-0 z-40 bg-black/50"
            />
          )}
          <motion.div
            ref={popoverRef}
            initial={isMobile ? { y: "100%" } : { opacity: 0, x: -8 }}
            animate={isMobile ? { y: 0 } : { opacity: 1, x: 0 }}
            exit={isMobile ? { y: "100%" } : { opacity: 0, x: -8 }}
            transition={isMobile ? { type: "spring", damping: 30, stiffness: 300 } : { duration: 0.15 }}
            className={isMobile
              ? "glass-overlay fixed inset-x-0 bottom-0 z-50 rounded-t-2xl"
              : "glass-popover fixed z-50 rounded-xl"
            }
            style={isMobile ? { maxHeight: "70vh" } : {
              left: 72,
              bottom: 80,
              width: 360,
              maxHeight: 480,
              ...anchorStyle,
            }}
          >
          {/* Mobile drag indicator */}
          {isMobile && (
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
            <span className="text-sm font-semibold text-[var(--color-text)]">
              Notifications
            </span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--color-text-muted)]">
                {notifications.length > 0 ? `${notifications.length} active` : ""}
              </span>
              {notifications.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clearAllNotifications()}
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                  aria-label="Clear all notifications"
                >
                  Clear all
                </button>
              )}
            </div>
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
                      // chat_id is null for legacy entries; in that case the
                      // navigation falls back to selecting the task only.
                      onNavigate?.("tasks", {
                        taskId: n.task_id,
                        projectId: n.project_id,
                        viewMode: "terminal",
                        ...(n.chat_id ? { chatId: n.chat_id } : {}),
                      });
                      onClose();
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
