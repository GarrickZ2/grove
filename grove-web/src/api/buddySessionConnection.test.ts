import { afterEach, expect, it, vi } from "vitest";
import { afterHistory, connectBuddySession } from "./buddySessionConnection";
import { getChatHistory } from "./tasks";
import type { Buddy } from "./buddies";
vi.mock("./tasks", () => ({ getChatHistory: vi.fn() }));
vi.mock("./client", () => ({ getApiHost: () => "localhost", appendHmacToUrl: async (url: string) => url }));
vi.mock("./chatSockets", () => ({ getChatSocket: () => null, registerChatSocket: vi.fn() }));
vi.mock("../components/Tasks/TaskView/chatConnectionAttempt", () => ({ withConnectionDeadline: (fn: () => unknown) => fn(), watchChatConnection: () => vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
it("removes overlapping history chunks without removing new chunks or pending snapshots", () => {
  const text = { type: "message_chunk", text: "Hello" };
  const pending = { type: "permission_request", id: "p" };
  expect(afterHistory([text], [{ type: "session_ready" }, text, pending, { ...text, text: " world" }])).toEqual([{ type: "session_ready" }, pending, { ...text, text: " world" }]);
  expect(afterHistory([text, { type: "complete" }], [text])).toEqual([text]);
});
it("sets compact on readiness, buffers live events during history load, and releases its socket", async () => {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget { send = vi.fn(); close = vi.fn(); url: string; constructor(url: string) { super(); this.url = url; sockets.push(this); } }
  vi.stubGlobal("WebSocket", FakeSocket);
  let resolve!: (value: Awaited<ReturnType<typeof getChatHistory>>) => void;
  vi.mocked(getChatHistory).mockReturnValue(new Promise(done => { resolve = done; }));
  const callbacks = { history: vi.fn(), event: vi.fn(), ready: vi.fn(), error: vi.fn() };
  const dispose = connectBuddySession({ project_hash: "p", local_task_id: "_local", active_session_id: "s" } as Buddy, callbacks);
  await Promise.resolve(); await Promise.resolve();
  const socket = sockets[0];
  socket!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session_ready" }) }));
  socket!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "permission_request", id: "request" }) }));
  expect(callbacks.event).not.toHaveBeenCalled();
  expect(socket!.send).toHaveBeenCalledWith(JSON.stringify({ type: "set_queue_mode", mode: "compact" }));
  resolve({ events: [], total: 0, runtime: { active: true, busy: true }, session: null });
  await vi.waitFor(() => expect(callbacks.history).toHaveBeenCalledWith([], true, 0));
  expect(callbacks.event).toHaveBeenCalledWith({ type: "permission_request", id: "request" });
  dispose(); expect(socket!.close).toHaveBeenCalledOnce();
});

it("loads only the recent turns of the active Segment and reports where they start", async () => {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget { send = vi.fn(); close = vi.fn(); url: string; constructor(url: string) { super(); this.url = url; sockets.push(this); } }
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.mocked(getChatHistory).mockResolvedValue({ events: [{ type: "message_chunk", text: "Recent" }], total: 40, start: 31, runtime: { active: true, busy: false }, session: null });
  const callbacks = { history: vi.fn(), event: vi.fn(), ready: vi.fn(), error: vi.fn() };
  const dispose = connectBuddySession({ project_hash: "p", local_task_id: "_local", active_session_id: "current" }, callbacks, { recentTurns: 20 });
  await vi.waitFor(() => expect(callbacks.history).toHaveBeenCalledOnce());
  // Ended Segments are paged in later, on demand.
  expect(getChatHistory).toHaveBeenCalledOnce();
  expect(getChatHistory).toHaveBeenCalledWith("p", "_local", "current", 0, { recentTurns: 20 });
  expect(callbacks.history).toHaveBeenCalledWith([{ type: "message_chunk", text: "Recent" }], false, 31);
  expect(sockets[0].url).toContain("/chats/current/ws");
  sockets[0].dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message_chunk", text: "Live answer" }) }));
  expect(callbacks.event).toHaveBeenLastCalledWith({ type: "message_chunk", text: "Live answer" });
  dispose();
});

it("ignores delayed old history after switching away", async () => {
  class FakeSocket extends EventTarget { send = vi.fn(); close = vi.fn(); }
  vi.stubGlobal("WebSocket", FakeSocket);
  let resolve!: (value: Awaited<ReturnType<typeof getChatHistory>>) => void;
  vi.mocked(getChatHistory).mockReturnValue(new Promise(done => { resolve = done; }));
  const callbacks = { history: vi.fn(), event: vi.fn(), ready: vi.fn(), error: vi.fn() };
  const dispose = connectBuddySession({ project_hash: "p", local_task_id: "_local", active_session_id: "old", segments: [] } as unknown as Buddy, callbacks);
  await vi.waitFor(() => expect(getChatHistory).toHaveBeenCalled());
  dispose();
  resolve({ events: [{ type: "message_chunk", text: "Late history" }], total: 1, runtime: { active: false, busy: false }, session: null });
  await new Promise(done => setTimeout(done, 0));
  expect(callbacks.history).not.toHaveBeenCalled();
  expect(callbacks.event).not.toHaveBeenCalled();
});
