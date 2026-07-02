import { useEffect } from "react";

interface UseChatDeepLinkParams {
  /** Chat to switch to. No-op while falsy — callers don't need to guard. */
  chatId: string | null | undefined;
  /** The project/task the chat belongs to. Must be the ids TaskChat will
   *  actually mount with (whatever page-specific task-selection step the
   *  caller does, if any, should already be underway/complete). */
  projectId: string | null | undefined;
  taskId: string | null | undefined;
  /** Called once the deep-link has been dispatched. Omit if the caller
   *  already clears its own pending-navigation state elsewhere (e.g. a
   *  broader "select this task" effect that fires regardless of whether
   *  a chatId was present). */
  onConsumed?: () => void;
}

/**
 * Switch TaskChat (whichever page mounted it — Tasks, Blitz, Work, ...) to
 * a specific chat session.
 *
 * Single source of truth for the `window.__grove_pending_chat` +
 * `grove:switch-chat` handoff that `useInitialChatLoad` (TaskChat.tsx)
 * consumes. Every surface that can send a "open task X, chat Y" deep-link
 * (notifications, tray, Radio, the Dynamic Island live-activity alert, ...)
 * needs to call this the same way. Before this hook existed, each page
 * hand-copied the fragment below — easy to simply forget on a new page
 * (Work didn't have it for a while), silently landing on the right task
 * without ever switching chats. New pages that can receive a chat deep-link
 * should call this instead of re-implementing it.
 */
export function useChatDeepLink({ chatId, projectId, taskId, onConsumed }: UseChatDeepLinkParams): void {
  useEffect(() => {
    if (!chatId || !projectId || !taskId) return;
    (window as unknown as Record<string, unknown>).__grove_pending_chat = {
      projectId,
      taskId,
      chatId,
    };
    window.dispatchEvent(
      new CustomEvent("grove:switch-chat", {
        detail: { projectId, taskId, chatId },
      }),
    );
    onConsumed?.();
  }, [chatId, projectId, taskId, onConsumed]);
}
