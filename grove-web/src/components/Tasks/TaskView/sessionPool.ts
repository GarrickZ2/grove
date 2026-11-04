import { BACKGROUND_CHAT_IDLE_MS } from "./backgroundChatConnections";
import { CHAT_HISTORY_PREFERENCES_CHANGED, loadChatHistoryPreferences } from "./chatHistoryPreferences";

/** Heap budget for parked transcripts, whatever the Session limit allows. */
export const SESSION_POOL_MAX_BYTES = 300 * 1024 * 1024;
const IDLE_CHECK_MS = 30 * 1000;

export interface ParkedSession<T> {
  data: T;
  /** Still delivering events. Null when only the transcript is kept. */
  socket: WebSocket | null;
  viewedAt: number;
  /** Last frame of any kind, which is what proves the transport is alive. */
  lastMessageAt: number;
  /** Last real traffic; heartbeats keep a socket alive but do not count here. */
  lastActivityAt: number;
  apply: (data: T, event: { type?: string }) => void;
  /** Busy Sessions are the ones the user will come back to, so they are never evicted.
   *  False once the socket is gone: nothing could report the turn ending. */
  isBusy: (data: T) => boolean;
  onSocketLost: (data: T) => void;
}

interface Entry extends ParkedSession<unknown> {
  sizeBytes: number;
  detach: () => void;
}

const entries = new Map<string, Entry>();
let idleTimer: ReturnType<typeof setInterval> | undefined;
let watchingLimit = false;

/** Strings dominate a transcript; each object or array adds a little on top. */
export function estimateSessionBytes(value: unknown): number {
  let bytes = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === "string") bytes += item.length;
    else if (item && typeof item === "object") {
      bytes += 32;
      for (const child of Object.values(item)) stack.push(child);
    }
  }
  return bytes;
}

function dropSocket(entry: Entry, reason: string) {
  const socket = entry.socket;
  entry.detach();
  entry.socket = null;
  entry.onSocketLost(entry.data);
  socket?.close(1000, reason);
}

export function releaseIdleSockets(now = Date.now()) {
  for (const entry of entries.values()) {
    if (entry.socket && now - entry.lastActivityAt >= BACKGROUND_CHAT_IDLE_MS) dropSocket(entry, "background_idle");
  }
  if (![...entries.values()].some((entry) => entry.socket)) {
    clearInterval(idleTimer);
    idleTimer = undefined;
  }
}

/** Oldest-viewed first; Sessions still working stay however far over the limits we are. */
function enforceLimits() {
  const limit = loadChatHistoryPreferences().recentSessions;
  let bytes = [...entries.values()].reduce((total, entry) => total + entry.sizeBytes, 0);
  const oldest = [...entries.entries()].sort(([, a], [, b]) => a.viewedAt - b.viewedAt);
  for (const [key, entry] of oldest) {
    if (entries.size <= limit && bytes <= SESSION_POOL_MAX_BYTES) break;
    if (entry.isBusy(entry.data)) continue;
    dropSocket(entry, "session_pool_evicted");
    entries.delete(key);
    bytes -= entry.sizeBytes;
  }
}

/** Keeps a Session up to date while nothing on screen owns it. */
export function parkSession<T>(key: string, session: ParkedSession<T>) {
  if (!watchingLimit) {
    watchingLimit = true;
    window.addEventListener(CHAT_HISTORY_PREFERENCES_CHANGED, enforceLimits);
  }
  const previous = entries.get(key);
  if (previous) {
    if (previous.socket !== session.socket) dropSocket(previous, "session_pool_replaced");
    else previous.detach();
    entries.delete(key);
  }
  const entry: Entry = {
    ...(session as ParkedSession<unknown>),
    sizeBytes: estimateSessionBytes(session.data),
    detach: () => {},
  };
  const { socket } = entry;
  if (socket) {
    const message = (raw: MessageEvent) => {
      const now = Date.now();
      entry.lastMessageAt = now;
      let event: { type?: string };
      try { event = JSON.parse(raw.data); } catch { return; }
      if (event.type === "heartbeat") return;
      entry.lastActivityAt = now;
      entry.apply(entry.data, event);
    };
    const closed = () => { entry.detach(); entry.socket = null; entry.onSocketLost(entry.data); };
    socket.addEventListener("message", message);
    socket.addEventListener("close", closed);
    entry.detach = () => {
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", closed);
    };
    idleTimer ??= setInterval(releaseIdleSockets, IDLE_CHECK_MS);
  }
  entries.set(key, entry);
  enforceLimits();
}

/** Hands a parked Session back to its surface, which owns the socket from here on. */
export function adoptSession<T>(key: string): ParkedSession<T> | null {
  const entry = entries.get(key);
  if (!entry) return null;
  entry.detach();
  entries.delete(key);
  return entry as unknown as ParkedSession<T>;
}

export function parkedSessionKeys(prefix: string): string[] {
  return [...entries.keys()].filter((key) => key.startsWith(prefix));
}

/** Test seam: the pool is module state. */
export function resetSessionPool() {
  for (const entry of entries.values()) dropSocket(entry, "session_pool_reset");
  entries.clear();
  clearInterval(idleTimer);
  idleTimer = undefined;
}
