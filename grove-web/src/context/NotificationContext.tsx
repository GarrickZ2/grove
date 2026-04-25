import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { listAllHooks, dismissHook } from "../api/hooks";
import type { HookEntryResponse } from "../api/hooks";
import { useRadioEvents } from "../hooks/useRadioEvents";

interface NotificationContextType {
  notifications: HookEntryResponse[];
  unreadCount: number;
  dismissNotification: (projectId: string, taskId: string) => Promise<void>;
  refreshNotifications: () => Promise<void>;
  getTaskNotification: (taskId: string) => HookEntryResponse | undefined;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<HookEntryResponse[]>([]);

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

  // Pure-push refresh:
  //   - `hook_added` fires whenever any code path writes a notification
  //     (ACP completion, `grove hooks` CLI, future MCP server, …).
  //   - `onConnected` fires on initial WS open AND on every reconnect — also
  //     serves as the initial-load trigger so we don't double-fetch on mount.
  //     If the WS never opens (e.g. server down), the badge stays empty,
  //     which is the correct fail-closed behaviour.
  // No polling: the event channel is the single source of truth.
  useRadioEvents({
    onHookAdded: useCallback(() => {
      void fetchNotifications();
    }, [fetchNotifications]),
    onConnected: useCallback(() => {
      void fetchNotifications();
    }, [fetchNotifications]),
  });

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

// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return context;
}
