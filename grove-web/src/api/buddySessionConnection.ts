import { appendHmacToUrl, getApiHost } from "./client";
import { getChatHistory } from "./tasks";
import { getChatSocket, registerChatSocket } from "./chatSockets";
import { watchChatConnection, withConnectionDeadline } from "../components/Tasks/TaskView/chatConnectionAttempt";
import type { Buddy } from "./buddies";
import type { BuddyEvent } from "../components/Buddy/timeline/buddyTimelineState";
import type { BuddySegmentHistory } from "../components/Buddy/timeline/buddySegmentHistory";

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

/** Attach to the same session protocol as TaskChat. Never create another session. */
export function connectBuddySession(buddy: Buddy, callbacks: { history: (events: BuddyEvent[], busy: boolean, previous: BuddySegmentHistory[]) => void; event: (event: BuddyEvent) => void; ready: (ready: boolean) => void; error: (message: string) => void }) {
  let stopped = false, socket: WebSocket | null = null, owned = false, releaseWatch: (() => void) | undefined;
  let hydrated = false;
  const buffered: BuddyEvent[] = [];
  const received = (raw: MessageEvent) => {
    let event: BuddyEvent;
    try { event = JSON.parse(raw.data) as BuddyEvent; } catch { return; }
    if (event.type === "session_ready") { socket?.send(JSON.stringify({ type: "set_queue_mode", mode: "compact" })); callbacks.ready(true); }
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
      } else { socket.send(JSON.stringify({ type: "set_queue_mode", mode: "compact" })); callbacks.ready(true); }
      socket.addEventListener("message", received); socket.addEventListener("close", closed);
      const previous = (buddy.segments ?? []).filter(segment => segment.session_id !== buddy.active_session_id && segment.ended_at).sort((a, b) => a.seq - b.seq);
      const [history, previousResults] = await withConnectionDeadline(() => Promise.all([
        getChatHistory(buddy.project_hash, buddy.local_task_id, buddy.active_session_id),
        Promise.allSettled(previous.map(async segment => ({
          session_id: segment.session_id,
          ended_at: segment.ended_at!,
          events: (await getChatHistory(buddy.project_hash, buddy.local_task_id, segment.session_id)).events as BuddyEvent[],
        }))),
      ]), 20000, "Could not load conversation history.");
      if (stopped) return;
      callbacks.history(history.events as BuddyEvent[], history.runtime?.busy ?? false, previousResults.flatMap(result => result.status === "fulfilled" ? [result.value] : []));
      if (previousResults.some(result => result.status === "rejected")) callbacks.error("Some earlier conversation history could not be loaded. Reconnect to retry.");
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
