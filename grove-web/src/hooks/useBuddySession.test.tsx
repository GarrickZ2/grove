vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "false"));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useBuddySession } from "./useBuddySession";
import { connectBuddySession } from "../api/buddySessionConnection";
import { getChatSocket } from "../api/chatSockets";
import { createBuddiesMock } from "../api/buddies.mock";
vi.mock("../api/buddySessionConnection", () => ({ connectBuddySession: vi.fn() }));
vi.mock("../api/chatSockets", () => ({ getChatSocket: vi.fn() }));

it("hydrates history, responds through the existing socket, and releases connections on retry and unmount", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const dispose = vi.fn(), send = vi.fn();
  let callbacks!: Parameters<typeof connectBuddySession>[1];
  vi.mocked(connectBuddySession).mockImplementation((_buddy, handlers) => { callbacks = handlers; return dispose; });
  vi.mocked(getChatSocket).mockReturnValue({ readyState: WebSocket.OPEN, send } as unknown as WebSocket);
  const buddy = createBuddiesMock().get("mock-chief");
  let session!: ReturnType<typeof useBuddySession>;
  function Harness() { session = useBuddySession(buddy); return null; }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  expect(session.loading).toBe(true);
  expect(vi.mocked(connectBuddySession).mock.calls[0][0].segments).toEqual(buddy.segments.map(({ session_id, seq, ended_at }) => ({ session_id, seq, ended_at })));
  act(() => {
    callbacks.history([{ type: "message_chunk", text: "History", message_id: "h" }], true, [{ session_id: "old", ended_at: "2026-10-30T01:00:00Z", events: [{ type: "message_chunk", text: "Previous Agent", message_id: "h" }] }]);
    callbacks.ready(true);
    callbacks.event({ type: "permission_request", id: "p", title: "Approve", options: [] });
  });
  expect(session.state.messages[0]).toMatchObject({ type: "assistant", content: "Previous Agent" });
  expect(session.state.messages[1]).toMatchObject({ type: "assistant", content: "History" });
  expect(session.loading).toBe(false);
  act(() => callbacks.event({ type: "message_chunk", text: " continues", message_id: "h" }));
  expect(session.state.messages.map(message => "content" in message ? message.content : undefined)).toEqual(["Previous Agent", "History continues"]);
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
  act(() => root.unmount());
  expect(dispose).toHaveBeenCalledTimes(2);
  vi.resetAllMocks(); vi.unstubAllGlobals();
});
