import { useEffect, useRef } from "react";
import { useNotifications } from "../../context";
import { useIsMobile } from "../../hooks";
import type { HookEntryResponse } from "../../api/hooks";

interface UseNotificationPopoverOptions {
  isOpen: boolean;
  onClose: () => void;
  onNavigate?: (page: string, data?: Record<string, unknown>) => void;
}

/** Shared state and behavior behind the notification popovers (classic sidebar and Orbit). */
export function useNotificationPopover({ isOpen, onClose, onNavigate }: UseNotificationPopoverOptions) {
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

  const openNotification = (n: HookEntryResponse) => {
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
  };

  return { notifications, dismissNotification, clearAllNotifications, openNotification, popoverRef, isMobile };
}
