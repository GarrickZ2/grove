import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { listAllHooks, dismissHook, clearAllHooks } from "../api/hooks";
import type { HookEntryResponse } from "../api/hooks";
import type { RadioEvent } from "../api/walkieTalkie";
import { useRadioEvents } from "../hooks/useRadioEvents";
import { renderHookNotification } from "../notifications/desktopNotifier";

interface NotificationContextType {
  notifications: HookEntryResponse[];
  unreadCount: number;
  dismissNotification: (projectId: string, taskId: string) => Promise<void>;
  clearAllNotifications: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  getTaskNotification: (projectId: string, taskId: string) => HookEntryResponse | undefined;
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

  const handleClearAll = useCallback(async () => {
    try {
      await clearAllHooks();
      setNotifications([]);
    } catch {
      return;
    }
  }, []);

  // Match on BOTH project_id and task_id: task ids are only unique within a
  // project (every project's Local Task shares the id "_local"), so keying by
  // task_id alone lit up the Local card of every project in cross-project
  // sidebars whenever any one of them completed.
  const getTaskNotification = useCallback(
    (projectId: string, taskId: string) =>
      notifications.find((n) => n.project_id === projectId && n.task_id === taskId),
    [notifications]
  );

  // Pure-push refresh:
  //   - `hook_added` fires whenever any code path writes a notification
  //     (ACP completion, `grove hooks` CLI, hooks report API, …).
  //   - `onConnected` fires on initial WS open AND on every reconnect — also
  //     serves as the initial-load trigger so we don't double-fetch on mount.
  //     If the WS never opens (e.g. server down), the badge stays empty,
  //     which is the correct fail-closed behaviour.
  // No polling: the event channel is the single source of truth.
  //
  // The same fact also feeds the frontend notification engine — banner +
  // sound on THIS surface when the backend isn't already rendering for a
  // human on its own machine (see desktopNotifier.ts).
  useRadioEvents({
    onHookAdded: useCallback(
      (
        _projectId: string,
        _taskId: string,
        payload?: Extract<RadioEvent, { type: "hook_added" }>,
      ) => {
        void fetchNotifications();
        if (payload) renderHookNotification(payload);
      },
      [fetchNotifications],
    ),
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
        clearAllNotifications: handleClearAll,
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
