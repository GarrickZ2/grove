vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "false"));
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBuddyComposer } from "./useBuddyComposer";
import { createBuddiesMock } from "../api/buddies.mock";
import { getChatSocket } from "../api/chatSockets";

vi.mock("../api/chatSockets", () => ({ getChatSocket: vi.fn(), subscribeChatSockets: () => () => {}, sendSessionInput: vi.fn() }));
let root: Root;
let composer: ReturnType<typeof useBuddyComposer>;
const buddy = createBuddiesMock().get("mock-release");
function Harness() {
  const current = useBuddyComposer(buddy, vi.fn());
  useEffect(() => { composer = current; });
  return null;
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); root = createRoot(document.createElement("div")); });
afterEach(() => { act(() => root.unmount()); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("sends the existing cancel event to the active Buddy session socket", () => {
  const send = vi.fn();
  vi.mocked(getChatSocket).mockReturnValue({ readyState: WebSocket.OPEN, send } as unknown as WebSocket);
  act(() => root.render(<Harness />));
  act(() => composer.stop());
  expect(getChatSocket).toHaveBeenCalledWith(buddy.project_hash, buddy.local_task_id, buddy.active_session_id);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "cancel" }));
});

it.each([null, WebSocket.CONNECTING, WebSocket.CLOSED])("reports an unavailable socket (%s) instead of silently ignoring cancellation", (readyState) => {
  const send = vi.fn();
  vi.mocked(getChatSocket).mockReturnValue(readyState === null ? null : { readyState, send } as unknown as WebSocket);
  act(() => root.render(<Harness />));
  expect(() => composer.stop()).toThrow("Wait for the session to reconnect before stopping.");
  expect(send).not.toHaveBeenCalled();
});
