import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Buddy } from "../../../api/buddies";
import { BuddyMini } from "./BuddyMini";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
const api = vi.hoisted(() => ({ current: null as unknown as Buddy }));
const radio = vi.hoisted(() => ({ onConnected: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging: async () => {} }) }));
vi.mock("../../../orbit/ui/OrbitInterfaceProvider", () => ({ OrbitInterfaceProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../../../hooks/useShellAuth", () => ({ useShellAuth: () => ({ authReady: true, remoteServer: false }) }));
vi.mock("../../../context", () => ({ ConfigProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../../../hooks/useRadioEvents", () => ({ useRadioEvents: (handlers: { onConnected: () => void }) => { radio.onConnected = handlers.onConnected; return { radioClients: 0 }; } }));
vi.mock("../BuddyConversation", () => ({ BuddyConversation: () => <div className="conversation" /> }));
vi.mock("../../../api/buddies", () => ({ getBuddy: async () => api.current, listBuddies: async () => [api.current] }));

const buddy = (patch: Partial<Buddy>) => ({ id: "b1", name: "Demo", avatar: null, status: "idle", waiting_delegations: 0, last_message_preview: "", last_activity_at: null, active_session_id: "s", ...patch }) as Buddy;
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.history.replaceState(null, "", "/buddy-mini.html?id=b1"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const refresh = async (next: Partial<Buddy>) => { api.current = buddy(next); await act(async () => radio.onConnected!()); await settle(); };
const collapse = async () => {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Collapse"]')!.click());
  act(() => { host.querySelector(".buddy-mini")!.dispatchEvent(new Event("animationend", { bubbles: true })); });
  await settle();
};

it("shows typing dots while working, then pops the reply when the turn ends", async () => {
  api.current = buddy({ status: "working" });
  act(() => root.render(<BuddyMini />));
  await settle();
  await collapse();
  expect(host.querySelector(".buddy-mini-say.is-typing")).not.toBeNull();
  expect(tauri.invoke).toHaveBeenLastCalledWith("buddy_mini_set_collapsed_size", { width: 154, height: 130 });
  await refresh({ status: "idle", last_message_preview: "Release notes look good." });
  expect(host.querySelector(".buddy-mini-say.is-reply")?.textContent).toBe("Release notes look good.");
  expect(tauri.invoke).toHaveBeenLastCalledWith("buddy_mini_set_collapsed_size", { width: 340, height: 180 });
  // Clicking the reply opens the conversation.
  act(() => host.querySelector<HTMLButtonElement>(".buddy-mini-say")!.click());
  await settle();
  expect(host.querySelector(".conversation")).not.toBeNull();
});

it("keeps asking while the Buddy waits on the user", async () => {
  api.current = buddy({});
  act(() => root.render(<BuddyMini />));
  await settle();
  await collapse();
  expect(host.querySelector(".buddy-mini-say")).toBeNull();
  await refresh({ status: "waiting" });
  expect(host.querySelector(".buddy-mini-say.is-waiting")?.textContent).toBe("Needs your approval");
});
