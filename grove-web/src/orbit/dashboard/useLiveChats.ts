import { useEffect, useReducer } from "react";
import { apiClient } from "../../api/client";
import { refreshRadioActivity, useRadioEvents } from "../../hooks/useRadioEvents";
import { liveChatsReducer, type LiveChats } from "./liveChats";

/**
 * Every live agent session's status, permission request and input request,
 * kept current from the radio channel: an `activity_snapshot` on (re)connect,
 * then `chat_status` / `chat_input_status` pushes.
 */
export function useLiveChats(): LiveChats {
  const [chats, dispatch] = useReducer(liveChatsReducer, {});
  useRadioEvents({
    onEvent: (event) => {
      if (!event || typeof event !== "object" || !("type" in event)) return;
      const message = event as Record<string, unknown>;
      if (message.type === "activity_snapshot" && Array.isArray(message.chats)) {
        dispatch({ type: "snapshot", chats: message.chats, now: Date.now() });
      } else if (
        message.type === "chat_input_status"
        && typeof message.project_id === "string" && typeof message.task_id === "string"
        && typeof message.chat_id === "string" && typeof message.waiting_for_input === "boolean"
      ) {
        dispatch({ type: "input", projectId: message.project_id, taskId: message.task_id, chatId: message.chat_id, waiting: message.waiting_for_input, now: Date.now() });
      }
    },
    onChatStatus: (_projectId, _taskId, _chatId, _status, payload) => {
      if (payload) dispatch({ type: "status", event: payload, now: Date.now() });
    },
    onConnected: refreshRadioActivity,
  });
  // The socket may already be open (the sidebar shares it), so ask now too.
  useEffect(() => { refreshRadioActivity(); }, []);
  return chats;
}

/** Answer a pending permission request (same endpoint as the tray and the island alert). */
export async function resolvePermission(projectId: string, taskId: string, chatId: string, optionId: string) {
  const result = await apiClient.post<
    { projectId: string; taskId: string; chatId: string; optionId: string },
    { status?: string; error?: string }
  >("/api/v1/tray/resolve-permission", { projectId, taskId, chatId, optionId });
  if (result?.error) throw new Error(result.error);
}
