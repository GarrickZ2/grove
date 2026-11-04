import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CHAT_IDLE_MS } from "./backgroundChatConnections";
import { CHAT_HISTORY_PREFERENCES_CHANGED, CHAT_HISTORY_PREFERENCES_KEY } from "./chatHistoryPreferences";
import { adoptSession, estimateSessionBytes, parkedSessionKeys, parkSession, releaseIdleSockets, resetSessionPool, SESSION_POOL_MAX_BYTES, type ParkedSession } from "./sessionPool";

function fakeSocket() {
  const socket = new EventTarget() as WebSocket & { close: ReturnType<typeof vi.fn>; emit: (data: unknown) => void };
  socket.close = vi.fn(() => { socket.dispatchEvent(new Event("close")); });
  socket.emit = (data) => { socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); };
  return socket;
}

interface Data { events: string[]; busy?: boolean; lost?: boolean; text?: string }
function session(data: Data, socket: WebSocket | null, viewedAt = 0, lastActivityAt = Date.now()): ParkedSession<Data> {
  return {
    data, socket, viewedAt, lastActivityAt, lastMessageAt: lastActivityAt,
    apply: (target, event) => { target.events.push(event.type ?? ""); },
    isBusy: (target) => !!target.busy,
    onSocketLost: (target) => { target.lost = true; },
  };
}
const setLimit = (recentSessions: number) => {
  localStorage.setItem(CHAT_HISTORY_PREFERENCES_KEY, JSON.stringify({ recentSessions }));
};

describe("sessionPool", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { resetSessionPool(); });

  it("keeps applying live events until the Session is adopted", () => {
    const socket = fakeSocket();
    const data: Data = { events: [] };
    parkSession("chat:a", session(data, socket));
    socket.emit({ type: "message_chunk" });
    const adopted = adoptSession<Data>("chat:a");
    socket.emit({ type: "complete" });
    expect(adopted?.socket).toBe(socket);
    expect(data.events).toEqual(["message_chunk"]);
    expect(socket.close).not.toHaveBeenCalled();
    expect(adoptSession("chat:a")).toBeNull();
  });

  it("does not count heartbeats as activity, only as transport liveness", () => {
    const socket = fakeSocket();
    const data: Data = { events: [] };
    const start = Date.now();
    parkSession("chat:a", session(data, socket, 0, start - 1000));
    socket.emit({ type: "heartbeat" });
    expect(data.events).toEqual([]);
    const adopted = adoptSession<Data>("chat:a")!;
    expect(adopted.lastMessageAt).toBeGreaterThanOrEqual(start);
    expect(adopted.lastActivityAt).toBe(start - 1000);
  });

  it("releases idle sockets but keeps the transcript", () => {
    const socket = fakeSocket();
    const data: Data = { events: [] };
    const now = Date.now();
    parkSession("chat:a", session(data, socket, 0, now));
    releaseIdleSockets(now + BACKGROUND_CHAT_IDLE_MS - 1);
    expect(socket.close).not.toHaveBeenCalled();
    releaseIdleSockets(now + BACKGROUND_CHAT_IDLE_MS);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(data.lost).toBe(true);
    expect(adoptSession<Data>("chat:a")).toMatchObject({ socket: null, data });
  });

  it("marks a Session stale when its socket drops on its own", () => {
    const socket = fakeSocket();
    const data: Data = { events: [] };
    parkSession("chat:a", session(data, socket));
    socket.dispatchEvent(new Event("close"));
    expect(data.lost).toBe(true);
    expect(adoptSession<Data>("chat:a")?.socket).toBeNull();
  });

  it("evicts the oldest viewed Session past the limit and closes its socket", () => {
    setLimit(2);
    const oldest = fakeSocket();
    parkSession("chat:old", session({ events: [] }, oldest, 1));
    parkSession("chat:mid", session({ events: [] }, null, 2));
    parkSession("chat:new", session({ events: [] }, null, 3));
    expect(parkedSessionKeys("chat:").sort()).toEqual(["chat:mid", "chat:new"]);
    expect(oldest.close).toHaveBeenCalledOnce();
  });

  it("never evicts a busy Session", () => {
    setLimit(1);
    parkSession("chat:busy", session({ events: [], busy: true }, null, 1));
    parkSession("chat:idle", session({ events: [] }, null, 2));
    expect(parkedSessionKeys("chat:")).toEqual(["chat:busy"]);
  });

  it("evicts by estimated size even under the Session limit", () => {
    const text = "x".repeat(SESSION_POOL_MAX_BYTES / 2 + 1);
    parkSession("chat:a", session({ events: [], text }, null, 1));
    parkSession("chat:b", session({ events: [], text }, null, 2));
    expect(parkedSessionKeys("chat:")).toEqual(["chat:b"]);
  });

  it("drops everything when the limit is 0, and applies a lowered limit at once", () => {
    parkSession("chat:a", session({ events: [] }, null, 1));
    parkSession("chat:b", session({ events: [] }, null, 2));
    setLimit(1);
    window.dispatchEvent(new Event(CHAT_HISTORY_PREFERENCES_CHANGED));
    expect(parkedSessionKeys("chat:")).toEqual(["chat:b"]);
    setLimit(0);
    window.dispatchEvent(new Event(CHAT_HISTORY_PREFERENCES_CHANGED));
    expect(parkedSessionKeys("chat:")).toEqual([]);
  });

  it("closes the older socket when a Session is parked twice", () => {
    const first = fakeSocket();
    const second = fakeSocket();
    parkSession("chat:a", session({ events: [] }, first));
    parkSession("chat:a", session({ events: [] }, second));
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
  });

  it("estimates transcripts without recursing on long arrays", () => {
    expect(estimateSessionBytes(Array.from({ length: 200000 }, () => "ab"))).toBeGreaterThan(400000);
  });
});
