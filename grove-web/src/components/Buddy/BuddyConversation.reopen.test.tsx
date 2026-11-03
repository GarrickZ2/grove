// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Buddy } from "../../api/buddies";
import { BuddyConversation } from "./BuddyConversation";

const session = vi.hoisted(() => ({ error: null as string | null, reconnect: vi.fn(), state: {}, promptCaps: null, hasEarlier: false, loadingEarlier: false, connected: true, loading: false, refreshMock: () => {}, dispatch: () => {}, sendEvent: () => {}, loadEarlier: async () => {} }));
vi.mock("../../hooks/useBuddySession", () => ({ useBuddySession: () => session }));
vi.mock("../../hooks/useBuddyComposer", () => ({ useBuddyComposer: () => ({ send: async () => {} }) }));
vi.mock("./BuddyComposer", () => ({ BuddyComposer: () => null }));
vi.mock("./timeline/BuddyTimeline", () => ({ BuddyTimeline: () => null }));
vi.mock("../../orbit/ui/interfaceContext", () => ({ useOrbitInterface: () => false }));

it("reconnects a connection lost out of sight when it is reopened", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const show = (open: boolean) => act(() => root.render(<BuddyConversation buddy={{ status: "idle" } as Buddy} onChanged={() => {}} open={open} />));
  show(false);
  session.error = "Session disconnected.";
  show(false);
  expect(session.reconnect).not.toHaveBeenCalled();
  show(true);
  expect(session.reconnect).toHaveBeenCalledOnce();
  show(true);
  expect(session.reconnect).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
