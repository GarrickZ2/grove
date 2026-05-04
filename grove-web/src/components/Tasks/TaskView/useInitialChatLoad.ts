import { useEffect } from "react";
import { listChats, createChat } from "../../../api";
import type { ChatSessionResponse } from "../../../api";
import {
  readLastActiveTab,
  writeLastActiveTab,
} from "../../../utils/lastActiveTab";

function buildDefaultSessionTitle(): string {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `New Session ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

interface Params {
  projectId: string;
  taskId: string;
  setChats: (chats: ChatSessionResponse[]) => void;
  setActiveChatId: (id: string) => void;
}

/**
 * Loads the chat list on mount (or when project/task changes), creating
 * an initial empty chat if none exist, then restores the last-active
 * chat (or honors a deep-linked Radio request via window.__grove_pending_chat).
 *
 * Pulled out of TaskChat so the captured-mutable `cancelled` flag and the
 * `let chatList` reassignment live in a small hook.
 */
export function useInitialChatLoad({
  projectId,
  taskId,
  setChats,
  setActiveChatId,
}: Params): void {
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // Pull as much branching logic as possible OUT of the try/catch:
      // React Compiler 1.0 bails out when a try block contains optional
      // chaining / logical-or / ternary / `if` over computed values.
      let chatList: ChatSessionResponse[] = [];
      try {
        chatList = await listChats(projectId, taskId);
      } catch (err) {
        console.error("Failed to load chats:", err);
        return;
      }
      if (chatList.length === 0) {
        try {
          const newChat = await createChat(
            projectId,
            taskId,
            buildDefaultSessionTitle(),
          );
          chatList = [newChat];
        } catch (err) {
          console.error("Failed to create initial chat:", err);
          return;
        }
      }
      if (cancelled) return;
      setChats(chatList);
      const win = window as unknown as Record<string, unknown>;
      const pending = win.__grove_pending_chat as
        | { projectId: string; taskId: string; chatId: string }
        | undefined;
      const pendingMatches =
        pending !== undefined &&
        pending.projectId === projectId &&
        pending.taskId === taskId &&
        chatList.some((c) => c.id === pending.chatId);
      if (pendingMatches && pending) {
        setActiveChatId(pending.chatId);
        writeLastActiveTab("chat", projectId, taskId, pending.chatId);
        delete win.__grove_pending_chat;
      } else {
        const remembered = readLastActiveTab("chat", projectId, taskId);
        const lastId = chatList[chatList.length - 1].id;
        const restoredId =
          remembered && chatList.some((c) => c.id === remembered)
            ? remembered
            : lastId;
        setActiveChatId(restoredId);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [projectId, taskId, setChats, setActiveChatId]);
}
