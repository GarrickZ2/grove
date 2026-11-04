vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "false"));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BUDDY_HISTORY_PAGE_TURNS, useBuddySession } from "./useBuddySession";
import { connectBuddySession, onBuddyAgentRestarted } from "../api/buddySessionConnection";
import { getChatSocket } from "../api/chatSockets";
import { getChatHistory } from "../api/tasks";
import { createBuddiesMock } from "../api/buddies.mock";
import { resetSessionPool } from "../components/Tasks/TaskView/sessionPool";
vi.mock("../api/buddySessionConnection", () => ({ connectBuddySession: vi.fn(), onBuddyAgentRestarted: vi.fn() }));
vi.mock("../api/chatSockets", () => ({ getChatSocket: vi.fn() }));
vi.mock("../api/tasks", () => ({ getChatHistory: vi.fn() }));

afterEach(() => { resetSessionPool(); vi.mocked(connectBuddySession).mockReset(); });

it("hydrates history, responds through the existing socket, and releases connections on retry and unmount", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const dispose = vi.fn(() => null), send = vi.fn();
  let callbacks!: Parameters<typeof connectBuddySession>[1];
  vi.mocked(connectBuddySession).mockImplementation((_buddy, handlers) => { callbacks = handlers; return dispose; });
  let restarted!: () => void;
  vi.mocked(onBuddyAgentRestarted).mockImplementation((_session, listener) => { restarted = listener; return () => {}; });
  vi.mocked(getChatSocket).mockReturnValue({ readyState: WebSocket.OPEN, send } as unknown as WebSocket);
  const buddy = createBuddiesMock().get("mock-chief");
  let session!: ReturnType<typeof useBuddySession>;
  function Harness() { session = useBuddySession(buddy); return null; }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  expect(session.loading).toBe(true);
  expect(vi.mocked(connectBuddySession).mock.calls[0][2]).toMatchObject({ recentTurns: BUDDY_HISTORY_PAGE_TURNS });
  act(() => {
    callbacks.history([{ type: "message_chunk", text: "History", message_id: "h" }], true, 0);
    callbacks.ready(true);
    callbacks.event({ type: "permission_request", id: "p", title: "Approve", options: [] });
  });
  expect(session.state.messages[0]).toMatchObject({ type: "assistant", content: "History" });
  expect(session.loading).toBe(false);
  act(() => callbacks.event({ type: "message_chunk", text: " continues", message_id: "h" }));
  expect(session.state.messages.map(message => "content" in message ? message.content : undefined)).toEqual(["History continues"]);
  expect(session.state.busy).toBe(true);
  expect(session.connected).toBe(true);
  session.sendEvent({ type: "permission_response", id: "p", option_id: "allow" });
  expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "permission_response", id: "p", option_id: "allow" }));
  act(() => { callbacks.ready(false); callbacks.error("Disconnected"); });
  expect(session.error).toBe("Disconnected");
  act(() => session.reconnect());
  expect(session.error).toBeNull();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(connectBuddySession).toHaveBeenCalledTimes(2);
  // Restarting the Agent from Settings reattaches without a manual Reconnect.
  expect(vi.mocked(onBuddyAgentRestarted).mock.calls[0][0]).toBe(buddy.active_session_id);
  act(() => restarted());
  expect(connectBuddySession).toHaveBeenCalledTimes(3);
  act(() => root.unmount());
  expect(dispose).toHaveBeenCalledTimes(3);
  vi.resetAllMocks(); vi.unstubAllGlobals();
});

it("pages earlier turns of the active Segment, then ended Segments, newest first", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let callbacks!: Parameters<typeof connectBuddySession>[1];
  vi.mocked(connectBuddySession).mockImplementation((_buddy, handlers) => { callbacks = handlers; return () => null; });
  vi.mocked(onBuddyAgentRestarted).mockReturnValue(() => {});
  const pages: Record<string, { text: string; start: number }> = { "current@30": { text: "Older", start: 0 }, "old@": { text: "Previous Agent", start: 0 } };
  vi.mocked(getChatHistory).mockImplementation(async (_p, _t, session, _offset, options) => {
    const page = pages[`${session}@${options?.before ?? ""}`];
    return { events: [{ type: "message_chunk", text: page.text, message_id: "a" }], total: 0, start: page.start, runtime: { active: false, busy: false }, session: null };
  });
  const buddy = { ...createBuddiesMock().get("mock-chief"), active_session_id: "current", segments: [
    { session_id: "old", seq: 1, agent: "a", started_at: "2026-10-30T00:00:00Z", ended_at: "2026-10-30T01:00:00Z" },
    { session_id: "current", seq: 2, agent: "b", started_at: "2026-10-30T01:00:00Z", ended_at: null },
  ] };
  let session!: ReturnType<typeof useBuddySession>;
  function Harness() { session = useBuddySession(buddy); return null; }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  act(() => callbacks.history([{ type: "message_chunk", text: "Recent", message_id: "a" }], false, 30));
  expect(session.hasEarlier).toBe(true);
  await act(async () => { await session.loadEarlier(); });
  await act(async () => { await session.loadEarlier(); });
  expect(session.state.messages.map(message => "content" in message ? message.content : undefined)).toEqual(["Previous Agent", "Older", "Recent"]);
  expect(new Set(session.state.rows.map(row => row.id)).size).toBe(session.state.rows.length);
  expect(session.hasEarlier).toBe(false);
  act(() => root.unmount());
  vi.resetAllMocks(); vi.unstubAllGlobals();
});

function parkedBuddyHarness() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const socket = new EventTarget() as WebSocket;
  socket.close = vi.fn();
  let callbacks!: Parameters<typeof connectBuddySession>[1];
  vi.mocked(connectBuddySession).mockImplementation((_buddy, handlers) => { callbacks = handlers; return () => socket; });
  vi.mocked(onBuddyAgentRestarted).mockImplementation((_session, listener) => { restart = listener; return () => {}; });
  let restart!: () => void;
  const buddy = createBuddiesMock().get("mock-chief");
  let session!: ReturnType<typeof useBuddySession>;
  function Harness() { session = useBuddySession(buddy); return null; }
  const open = () => {
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Harness />));
    return root;
  };
  return { socket, open, callbacks: () => callbacks, session: () => session, restart: () => restart() };
}

it("reopens a parked Buddy at once, with events from while it was closed", () => {
  const { socket, open, callbacks, session } = parkedBuddyHarness();
  const first = open();
  act(() => { callbacks().history([{ type: "message_chunk", text: "History", message_id: "h" }], false, 12); callbacks().ready(true); });
  act(() => first.unmount());
  expect(socket.close).not.toHaveBeenCalled();
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message_chunk", text: " and more", message_id: "h" }) }));
  open();
  expect(session().loading).toBe(false);
  expect(session().hasEarlier).toBe(true);
  expect(session().state.messages.map(message => "content" in message ? message.content : undefined)).toEqual(["History and more"]);
  expect(vi.mocked(connectBuddySession).mock.lastCall?.[2]).toMatchObject({ socket });
});

it("rebuilds from the server on Reconnect rather than from parked state", () => {
  const { socket, open, callbacks, session } = parkedBuddyHarness();
  open();
  act(() => callbacks().history([{ type: "message_chunk", text: "History", message_id: "h" }], false, 0));
  act(() => session().reconnect());
  expect(session().loading).toBe(true);
  expect(vi.mocked(connectBuddySession).mock.lastCall?.[2]?.socket).toBeNull();
  expect(socket.close).not.toHaveBeenCalled();
});
