import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { listAllHooks, dismissHook } from "../api/hooks";
import type { HookEntryResponse } from "../api/hooks";

interface NotificationContextType {
  notifications: HookEntryResponse[];
  unreadCount: number;
  dismissNotification: (projectId: string, taskId: string) => Promise<void>;
  refreshNotifications: () => Promise<void>;
  getTaskNotification: (taskId: string) => HookEntryResponse | undefined;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

const POLL_INTERVAL = 5000; // 5 seconds

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<HookEntryResponse[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const response = await listAllHooks();
      setNotifications(response.hooks);
    } catch {
      // Silently ignore fetch errors
    }
  }, []);

  const handleDismiss = useCallback(async (projectId: string, taskId: string) => {
    try {
      await dismissHook(projectId, taskId);
      setNotifications((prev) => prev.filter((n) => !(n.project_id === projectId && n.task_id === taskId)));
    } catch {
      // Silently ignore errors
    }
  }, []);

  const getTaskNotification = useCallback(
    (taskId: string) => notifications.find((n) => n.task_id === taskId),
    [notifications]
  );

  // Initial fetch + polling
  useEffect(() => {
    fetchNotifications();
    intervalRef.current = setInterval(fetchNotifications, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchNotifications]);

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount: notifications.length,
        dismissNotification: handleDismiss,
        refreshNotifications: fetchNotifications,
        getTaskNotification,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return context;
}
