import { useEffect, useRef, useState } from "react";
import type { RadioEvent, TargetMode, NodeStatus } from "../api/walkieTalkie";
import { getApiHost, appendHmacToUrl } from "../api/client";

export interface RadioEventCallbacks {
  onFocusTask?: (projectId: string, taskId: string, target?: TargetMode) => void;
  onFocusTarget?: (projectId: string, taskId: string, target: TargetMode) => void;
  onTerminalInput?: (projectId: string, taskId: string, text: string) => void;
  onPromptSent?: (projectId: string, taskId: string) => void;
  onTaskStatus?: (
    projectId: string,
    taskId: string,
    status: "idle" | "busy" | "disconnected",
  ) => void;
  onHookAdded?: (projectId: string, taskId: string) => void;
  /** Fired when the chat list under a task changes — typically after the
   *  `grove_agent_spawn` MCP tool creates a sibling session. Consumers should
   *  refetch the task's chat list (e.g. `listChats(projectId, taskId)`) so the
   *  new chat appears in the UI without manual refresh. */
  onChatListChanged?: (projectId: string, taskId: string) => void;
  /** Per-chat status transition (chat-grained, no dedup). Drives the agent
   *  graph's in-memory node status machine. */
  onChatStatus?: (
    projectId: string,
    taskId: string,
    chatId: string,
    status: NodeStatus,
  ) => void;
  /** Pending agent-to-agent message ticket inserted/deleted. Drives the agent
   *  graph's in-memory pending pair set so edge state can be derived locally. */
  onPendingChanged?: (
    projectId: string,
    taskId: string,
    payload: {
      msg_id: string;
      from_chat_id: string;
      to_chat_id: string;
      op: "inserted" | "deleted";
      body_excerpt?: string;
    },
  ) => void;
  /** Fired when the shared WS opens or reopens after a disconnect. Useful for
   *  consumers who need to re-sync state after a missed-events window. */
  onConnected?: () => void;
}

const RECONNECT_BASE_DELAY = 3000;
const RECONNECT_MAX_DELAY = 30000;

// ─── Module-level singleton shared across all useRadioEvents() callers ──────
// Each component that mounts the hook adds its callback bag to `subscribers`.
// We keep exactly one WebSocket open as long as at least one subscriber is
// mounted; opening N parallel sockets per page (one per consumer) was the
// previous behavior and wasted server-side resources.

interface SubscriberRef {
  current: RadioEventCallbacks;
}

const subscribers = new Set<SubscriberRef>();
let sharedWs: WebSocket | null = null;
let intentionalClose = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let radioClientCount = 0;
const clientCountListeners = new Set<(n: number) => void>();

function notifyClientCount() {
  for (const l of clientCountListeners) l(radioClientCount);
}

function dispatch(event: RadioEvent) {
  switch (event.type) {
    case "focus_task":
      for (const s of subscribers) s.current.onFocusTask?.(event.project_id, event.task_id, event.target);
      break;
    case "focus_target":
      for (const s of subscribers) s.current.onFocusTarget?.(event.project_id, event.task_id, event.target);
      break;
    case "terminal_input":
      for (const s of subscribers) s.current.onTerminalInput?.(event.project_id, event.task_id, event.text);
      break;
    case "prompt_sent":
      for (const s of subscribers) s.current.onPromptSent?.(event.project_id, event.task_id);
      break;
    case "task_status":
      for (const s of subscribers) s.current.onTaskStatus?.(event.project_id, event.task_id, event.agent_status);
      break;
    case "hook_added":
      for (const s of subscribers) s.current.onHookAdded?.(event.project_id, event.task_id);
      break;
    case "chat_list_changed":
      for (const s of subscribers)
        s.current.onChatListChanged?.(event.project_id, event.task_id);
      break;
    case "chat_status":
      for (const s of subscribers)
        s.current.onChatStatus?.(
          event.project_id,
          event.task_id,
          event.chat_id,
          event.status,
        );
      break;
    case "pending_changed":
      for (const s of subscribers)
        s.current.onPendingChanged?.(event.project_id, event.task_id, {
          msg_id: event.msg_id,
          from_chat_id: event.from_chat_id,
          to_chat_id: event.to_chat_id,
          op: event.op,
          body_excerpt: event.body_excerpt,
        });
      break;
    case "client_connected":
      radioClientCount += 1;
      notifyClientCount();
      break;
    case "client_disconnected":
      radioClientCount = Math.max(0, radioClientCount - 1);
      notifyClientCount();
      break;
    case "client_count":
      if ("count" in event && typeof (event as Record<string, unknown>).count === "number") {
        radioClientCount = (event as RadioEvent & { count: number }).count;
        notifyClientCount();
      }
      break;
  }
}

async function openSharedWs() {
  if (sharedWs) return;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = getApiHost();
  const url = await appendHmacToUrl(`${protocol}//${host}/api/v1/radio/events/ws`);
  // A second caller may have raced us — bail if so.
  if (sharedWs) return;

  const ws = new WebSocket(url);
  sharedWs = ws;
  intentionalClose = false;

  ws.onopen = () => {
    reconnectAttempts = 0;
    // Notify subscribers so they can do a one-shot re-sync (covers events
    // missed during the disconnect window — e.g. hooks fired while offline).
    for (const s of subscribers) s.current.onConnected?.();
  };

  ws.onmessage = (event) => {
    try {
      const data: RadioEvent = JSON.parse(event.data);
      dispatch(data);
    } catch {
      // ignore malformed
    }
  };

  ws.onclose = () => {
    sharedWs = null;
    radioClientCount = 0;
    notifyClientCount();
    if (intentionalClose || subscribers.size === 0) return;
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_DELAY,
    );
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openSharedWs();
    }, delay);
  };

  ws.onerror = () => {
    // onclose fires after onerror
  };
}

function maybeCloseSharedWs() {
  if (subscribers.size > 0) return;
  intentionalClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sharedWs) {
    sharedWs.close();
    sharedWs = null;
  }
}

/**
 * Hook for desktop Blitz to receive radio control events.
 * All callers share a single WebSocket connection at the module level.
 * Returns the number of connected Radio clients (phones).
 */
export function useRadioEvents(callbacks: RadioEventCallbacks): { radioClients: number } {
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  // Lazy initializer pulls the current module-level count at mount, so we
  // don't need a setState-in-effect call to re-sync.
  const [radioClients, setRadioClients] = useState(() => radioClientCount);

  useEffect(() => {
    subscribers.add(callbacksRef);
    const listener = (n: number) => setRadioClients(n);
    clientCountListeners.add(listener);
    void openSharedWs();

    return () => {
      subscribers.delete(callbacksRef);
      clientCountListeners.delete(listener);
      maybeCloseSharedWs();
    };
  }, []);

  return { radioClients };
}
