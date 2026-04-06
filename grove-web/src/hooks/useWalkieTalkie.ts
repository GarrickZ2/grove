import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupSnapshot, ChatRef } from "../data/types";
import type {
  WalkieTalkieClientMessage,
  WalkieTalkieServerMessage,
} from "../api/walkieTalkie";
import { getApiHost, appendHmacToUrl } from "../api/client";

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface WalkieTalkieState {
  connected: boolean;
  groups: GroupSnapshot[];
  currentGroupId: string | null;
  currentPosition: number | null;
  activeChat: ChatRef | null;
  availableChats: ChatRef[];
  theme: string | null;
  lastPromptStatus: {
    position: number;
    status: "ok" | "error";
    error?: string;
  } | null;
}

export interface WalkieTalkieActions {
  switchGroup: (groupId: string) => void;
  selectTask: (groupId: string, position: number) => void;
  sendPrompt: (
    groupId: string,
    position: number,
    text: string,
    chatId?: string,
  ) => void;
  switchChat: (
    groupId: string,
    position: number,
    direction: "next" | "prev",
  ) => void;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 30000;

export function useWalkieTalkie(): [WalkieTalkieState, WalkieTalkieActions] {
  const [connected, setConnected] = useState(false);
  const [groups, setGroups] = useState<GroupSnapshot[]>([]);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const [currentPosition, setCurrentPosition] = useState<number | null>(null);
  const [activeChat, setActiveChat] = useState<ChatRef | null>(null);
  const [availableChats, setAvailableChats] = useState<ChatRef[]>([]);
  const [theme, setTheme] = useState<string | null>(null);
  const [lastPromptStatus, setLastPromptStatus] =
    useState<WalkieTalkieState["lastPromptStatus"]>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  // ── Send helper ──────────────────────────────────────────────────────────

  const send = useCallback((msg: WalkieTalkieClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // ── Message handler ──────────────────────────────────────────────────────

  const handleMessage = useCallback(
    (msg: WalkieTalkieServerMessage) => {
      switch (msg.type) {
        case "connected": {
          setGroups(msg.groups);
          setTheme(msg.theme);
          setCurrentGroupId((prev) => {
            if (prev && msg.groups.some((g: GroupSnapshot) => g.id === prev)) return prev;
            return msg.groups.length > 0 ? msg.groups[0].id : null;
          });
          break;
        }

        case "task_status": {
          setGroups((prev) =>
            prev.map((g) => {
              const updated = { ...g, slot_statuses: { ...g.slot_statuses } };
              for (const slot of g.slots) {
                if (
                  slot.project_id === msg.project_id &&
                  slot.task_id === msg.task_id
                ) {
                  if (updated.slot_statuses[slot.position]) {
                    updated.slot_statuses[slot.position] = {
                      ...updated.slot_statuses[slot.position],
                      agent_status: msg.agent_status,
                    };
                  }
                }
              }
              return updated;
            }),
          );
          break;
        }

        case "prompt_sent": {
          setLastPromptStatus({
            position: msg.position,
            status: msg.status,
            ...(msg.error ? { error: msg.error } : {}),
          });
          break;
        }

        case "chat_info": {
          setActiveChat(msg.active_chat);
          setAvailableChats(msg.available_chats);
          break;
        }

        case "group_updated": {
          setGroups(msg.groups);
          break;
        }

        case "theme_changed": {
          setTheme(msg.theme);
          break;
        }
      }
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── WebSocket lifecycle ──────────────────────────────────────────────────

  const connect = useCallback(async () => {
    const protocol =
      window.location.protocol === "https:" ? "wss:" : "ws:";

    // Check for Radio server token (saved to sessionStorage before hash was cleared)
    const { getRadioToken } = await import("../api/client");
    const radioToken = getRadioToken();
    let url: string;

    if (radioToken) {
      // Radio server mode: connect to /ws on the same origin with token
      url = `${protocol}//${window.location.host}/ws?token=${radioToken}`;
    } else {
      // Main server mode: connect to the main API endpoint with HMAC
      const host = getApiHost();
      url = await appendHmacToUrl(
        `${protocol}//${host}/api/v1/walkie-talkie/ws`,
      );
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const data: WalkieTalkieServerMessage = JSON.parse(event.data);
        handleMessage(data);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      wsRef.current = null;
      setConnected(false);

      // In Radio token mode, reconnect on clean close (1000) or abnormal
      // network interruption (1006). Reject all other codes (e.g. 1008
      // Policy Violation = invalid token) as terminal.
      if (radioToken && event.code !== 1000 && event.code !== 1006) {
        return;
      }

      // Do NOT reconnect if:
      // - we intentionally closed the connection
      // - the server rejected the token (close code 1008 = Policy Violation)
      if (!intentionalCloseRef.current && event.code !== 1008) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped)
        const delay = Math.min(
          RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttemptsRef.current),
          RECONNECT_MAX_DELAY,
        );
        reconnectAttemptsRef.current++;
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };
  }, [handleMessage]);

  useEffect(() => {
    intentionalCloseRef.current = false;
    reconnectAttemptsRef.current = 0;
    connect();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const switchGroup = useCallback(
    (groupId: string) => {
      setCurrentGroupId(groupId);
      setCurrentPosition(null);
      setActiveChat(null);
      setAvailableChats([]);
      send({ type: "switch_group", group_id: groupId });
    },
    [send],
  );

  const selectTask = useCallback(
    (groupId: string, position: number) => {
      setCurrentGroupId(groupId);
      setCurrentPosition(position);
      setActiveChat(null);
      setAvailableChats([]);
      send({ type: "select_task", group_id: groupId, position });
    },
    [send],
  );

  const sendPrompt = useCallback(
    (groupId: string, position: number, text: string, chatId?: string) => {
      send({
        type: "send_prompt",
        group_id: groupId,
        position,
        text,
        ...(chatId ? { chat_id: chatId } : {}),
      });
    },
    [send],
  );

  const switchChat = useCallback(
    (groupId: string, position: number, direction: "next" | "prev") => {
      send({ type: "switch_chat", group_id: groupId, position, direction });
    },
    [send],
  );

  // ── Return ───────────────────────────────────────────────────────────────

  const state: WalkieTalkieState = {
    connected,
    groups,
    currentGroupId,
    currentPosition,
    activeChat,
    availableChats,
    theme,
    lastPromptStatus,
  };

  const actions: WalkieTalkieActions = {
    switchGroup,
    selectTask,
    sendPrompt,
    switchChat,
  };

  return [state, actions];
}
