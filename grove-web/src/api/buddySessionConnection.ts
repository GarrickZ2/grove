import { appendHmacToUrl, getApiHost } from "./client";
import { getChatHistory, reconnectChat } from "./tasks";
import { getChatSocket, registerChatSocket } from "./chatSockets";
import { watchChatConnection, withConnectionDeadline } from "../components/Tasks/TaskView/chatConnectionAttempt";
import type { Buddy } from "./buddies";
import type { BuddyEvent } from "../components/Buddy/timeline/buddyTimelineState";

/** Remove only the overlapping persisted tail; readiness and pending snapshots still replay. */
export function afterHistory(history: BuddyEvent[], buffered: BuddyEvent[]): BuddyEvent[] {
  const persisted = new Set(["user_message", "message_chunk", "message_content_chunk", "thought_chunk", "tool_call", "tool_call_update", "v2_message_bind", "v2_message_update", "v2_tool_update", "plan", "plan_update", "complete", "turn_interrupted"]);
  const tail = history.filter(event => persisted.has(event.type)).map(event => JSON.stringify(event));
  const live = buffered.flatMap((event, index) => persisted.has(event.type) ? [{ signature: JSON.stringify(event), index }] : []);
  for (let count = Math.min(tail.length, live.length); count > 0; count--) {
    if (live.slice(0, count).every((event, index) => event.signature === tail[tail.length - count + index])) {
      const skipped = new Set(live.slice(0, count).map(event => event.index));
      return buffered.filter((_, index) => !skipped.has(index));
    }
  }
  return buffered;
}

type SessionIdentity = Pick<Buddy, "project_hash" | "local_task_id" | "active_session_id">;

/** Attach to the same session protocol as TaskChat. Never create another session.
 *  `compact` is only for the Buddy's own Segment; observed subagent sessions keep their queue mode.
 *  With `recentTurns`, only the latest turns load; `history` gets the index they start at, so the
 *  rest (and earlier Segments) can be paged in on demand. */
export function connectBuddySession(buddy: SessionIdentity, callbacks: { history: (events: BuddyEvent[], busy: boolean, start: number) => void; event: (event: BuddyEvent) => void; ready: (ready: boolean) => void; error: (message: string) => void }, { compact = true, recentTurns }: { compact?: boolean; recentTurns?: number } = {}) {
  let stopped = false, socket: WebSocket | null = null, owned = false, releaseWatch: (() => void) | undefined;
  const queueMode = () => { if (compact) socket?.send(JSON.stringify({ type: "set_queue_mode", mode: "compact" })); };
  let hydrated = false;
  const buffered: BuddyEvent[] = [];
  const received = (raw: MessageEvent) => {
    let event: BuddyEvent;
    try { event = JSON.parse(raw.data) as BuddyEvent; } catch { return; }
    if (event.type === "session_ready") { queueMode(); callbacks.ready(true); }
    if (event.type === "session_ended") callbacks.ready(false);
    if (!hydrated) buffered.push(event); else callbacks.event(event);
  };
  const closed = () => { if (!stopped) { callbacks.ready(false); callbacks.error("Session disconnected. Reconnect to continue."); } };
  void (async () => {
    try {
      socket = getChatSocket(buddy.project_hash, buddy.local_task_id, buddy.active_session_id);
      if (!socket) {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const url = await withConnectionDeadline(() => appendHmacToUrl(`${protocol}//${getApiHost()}/api/v1/projects/${encodeURIComponent(buddy.project_hash)}/tasks/${encodeURIComponent(buddy.local_task_id)}/chats/${encodeURIComponent(buddy.active_session_id)}/ws`), 15000, "Could not prepare the session connection.");
        if (stopped) return;
        socket = new WebSocket(url); owned = true; registerChatSocket(socket);
        releaseWatch = watchChatConnection(socket, callbacks.error, () => {});
      } else { queueMode(); callbacks.ready(true); }
      socket.addEventListener("message", received); socket.addEventListener("close", closed);
      const history = await withConnectionDeadline(() => getChatHistory(buddy.project_hash, buddy.local_task_id, buddy.active_session_id, 0, recentTurns ? { recentTurns } : {}), 20000, "Could not load conversation history.");
      if (stopped) return;
      callbacks.history(history.events as BuddyEvent[], history.runtime?.busy ?? false, history.start ?? 0);
      if (owned) callbacks.event({ type: "buddy_reconcile" });
      for (const event of afterHistory(history.events as BuddyEvent[], buffered)) callbacks.event(event);
      hydrated = true;
    } catch (reason) {
      if (!stopped) {
        callbacks.error(reason instanceof Error ? reason.message : "Could not connect to this conversation.");
        for (const event of buffered) callbacks.event(event);
        hydrated = true;
      }
    }
  })();
  return () => { stopped = true; releaseWatch?.(); socket?.removeEventListener("message", received); socket?.removeEventListener("close", closed); if (owned) socket?.close(); };
}

const AGENT_RESTARTED = "grove:buddy-agent-restarted";

/** Restart the Buddy's ACP process, keeping its conversation. The next
 *  connection resumes the session with fresh MCP servers and instructions. */
export async function restartBuddyAgent(buddy: SessionIdentity): Promise<void> {
  await reconnectChat(buddy.project_hash, buddy.local_task_id, buddy.active_session_id);
  window.dispatchEvent(new CustomEvent(AGENT_RESTARTED, { detail: buddy.active_session_id }));
}

export function onBuddyAgentRestarted(sessionId: string, listener: () => void): () => void {
  const handle = (event: Event) => { if ((event as CustomEvent<string>).detail === sessionId) listener(); };
  window.addEventListener(AGENT_RESTARTED, handle);
  return () => window.removeEventListener(AGENT_RESTARTED, handle);
}
