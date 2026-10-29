import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import type { HookEntryResponse } from "../../api/hooks";
import { formatTimeAgo } from "../../utils/notificationFormat";
import { useNotificationPopover } from "./useNotificationPopover";

interface OrbitNotificationPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
}

/** Info stays neutral; only warn / critical carry color, like the project switcher's flags. */
function LevelIcon({ level }: { level: string }) {
  if (level === "critical") return <AlertCircle size={15} strokeWidth={1.7} className="orbit-notification-level is-error" />;
  if (level === "warn") return <AlertTriangle size={15} strokeWidth={1.7} className="orbit-notification-level is-warning" />;
  return <Info size={15} strokeWidth={1.7} className="orbit-notification-level" />;
}

function OrbitNotificationItem({ notification, onOpen, onDismiss }: { notification: HookEntryResponse; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="orbit-notification-item">
      <button type="button" className="orbit-notification-main" onClick={onOpen}>
        <LevelIcon level={notification.level} />
        <span className="orbit-notification-body">
          <span className="orbit-notification-title"><span className="orbit-truncate">{notification.task_name}</span><span className="orbit-notification-time">{formatTimeAgo(notification.timestamp)}</span></span>
          <span className="orbit-notification-project orbit-truncate">{notification.project_name}</span>
          {notification.message && <span className="orbit-notification-message">{notification.message}</span>}
        </span>
      </button>
      <button type="button" className="orbit-notification-dismiss" title="Dismiss" aria-label={`Dismiss notification for ${notification.task_name}`} onClick={onDismiss}><X size={14} /></button>
    </div>
  );
}

/** Orbit's notification list: a menu under the sidebar header on desktop, a bottom sheet on phones. */
export function OrbitNotificationPopover({ isOpen, onClose, onNavigate }: OrbitNotificationPopoverProps) {
  const { notifications, dismissNotification, clearAllNotifications, openNotification, popoverRef, isMobile } =
    useNotificationPopover({ isOpen, onClose, onNavigate });

  return (
    <AnimatePresence>
      {isOpen && <>
        {isMobile && <motion.div className="orbit-notification-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />}
        <motion.div ref={popoverRef} role="dialog" aria-label="Notifications" className={isMobile ? "orbit-notification-sheet" : "orbit-notification-menu"}
          initial={isMobile ? { y: "100%" } : { opacity: 0, y: -4 }} animate={isMobile ? { y: 0 } : { opacity: 1, y: 0 }} exit={isMobile ? { y: "100%" } : { opacity: 0, y: -4 }}
          transition={isMobile ? { type: "spring", damping: 30, stiffness: 300 } : { duration: 0.12 }}>
          {isMobile && <div className="orbit-notification-grabber" />}
          <div className="orbit-notification-header">
            <span>Notifications</span>
            {notifications.length > 0 && <span className="orbit-notification-count">{notifications.length}</span>}
            {notifications.length > 0 && <button type="button" className="orbit-notification-clear" aria-label="Clear all notifications" onClick={() => void clearAllNotifications()}>Clear all</button>}
          </div>
          <div className="orbit-notification-list">
            {notifications.length === 0
              ? <p className="orbit-notification-empty">No notifications</p>
              : notifications.map((n) => <OrbitNotificationItem key={`${n.project_id}-${n.task_id}`} notification={n} onOpen={() => openNotification(n)} onDismiss={() => void dismissNotification(n.project_id, n.task_id)} />)}
          </div>
        </motion.div>
      </>}
    </AnimatePresence>
  );
}
