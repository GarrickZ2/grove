import { useCallback, useEffect, useRef, useState } from "react";
import type { RadioEvent } from "../api/walkieTalkie";
import { getApiHost, appendHmacToUrl } from "../api/client";

export interface RadioEventCallbacks {
  onFocusTask?: (projectId: string, taskId: string) => void;
  onPromptSent?: (projectId: string, taskId: string) => void;
}

const RECONNECT_BASE_DELAY = 3000;
const RECONNECT_MAX_DELAY = 30000;

/**
 * Hook for desktop Blitz to receive radio control events.
 * Connects to /radio/events/ws and forwards events to callbacks.
 * Returns the number of connected Radio clients (phones).
 */
export function useRadioEvents(callbacks: RadioEventCallbacks): { radioClients: number } {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const [radioClients, setRadioClients] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const connect = useCallback(async () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = getApiHost();
    const url = await appendHmacToUrl(
      `${protocol}//${host}/api/v1/radio/events/ws`,
    );

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // Reset backoff on successful connection
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const data: RadioEvent = JSON.parse(event.data);
        switch (data.type) {
          case "focus_task":
            callbacksRef.current.onFocusTask?.(data.project_id, data.task_id);
            break;
          case "prompt_sent":
            callbacksRef.current.onPromptSent?.(data.project_id, data.task_id);
            break;
          case "client_connected":
            setRadioClients((prev) => prev + 1);
            break;
          case "client_disconnected":
            setRadioClients((prev) => Math.max(0, prev - 1));
            break;
          case "client_count":
            if ("count" in data && typeof (data as Record<string, unknown>).count === "number") {
              setRadioClients((data as RadioEvent & { count: number }).count);
            }
            break;
          // group_changed / theme_changed are handled by Blitz REST refresh, not needed here
        }
      } catch {
        // ignore malformed
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setRadioClients(0); // Reset on disconnect — count is stale after reconnect
      if (!intentionalCloseRef.current) {
        // Exponential backoff: 3s, 6s, 12s, 24s, 30s (capped)
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
      // onclose fires after onerror
    };
  }, []);

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

  return { radioClients };
}
