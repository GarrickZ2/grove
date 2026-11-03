vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "true"));
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuddyMini } from "./BuddyMini";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined), handlers: new Map<string, (event: { payload: string }) => void>(), startDragging: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, handler: (event: { payload: string }) => void) => { tauri.handlers.set(name, handler); return () => tauri.handlers.delete(name); } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging: tauri.startDragging }) }));
vi.mock("../../../orbit/ui/OrbitInterfaceProvider", () => ({ OrbitInterfaceProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../../../context", () => ({ ConfigProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../../../hooks/useShellAuth", () => ({ useShellAuth: () => ({ authReady: true, remoteServer: false }) }));
vi.mock("../../../hooks/useRadioEvents", () => ({ useRadioEvents: () => ({ radioClients: 0 }) }));
vi.mock("../BuddyConversation", () => ({ BuddyConversation: ({ buddy }: { buddy: { name: string } }) => <div className="conversation">Talking to {buddy.name}</div> }));

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.history.replaceState(null, "", "/buddy-mini.html?id=mock-chief"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it("shows the Buddy from the URL, switches on show events, and hands off to the main window", async () => {
  act(() => root.render(<BuddyMini />));
  await settle();
  expect(host.textContent).toContain("Talking to Chief");
  await act(async () => tauri.handlers.get("buddy-mini:show")!({ payload: "mock-inbox" }));
  await settle();
  expect(host.textContent).toContain("Talking to Inbox");
  act(() => button("Back to Grove").click());
  expect(tauri.invoke).toHaveBeenCalledWith("buddy_mini_open_in_main", { buddyId: "mock-inbox" });
});

it("collapses to the avatar bubble; a click expands it and a drag moves the window", async () => {
  act(() => root.render(<BuddyMini />));
  await settle();
  act(() => button("Collapse").click());
  // The panel shrinks into the corner first; the window follows when that ends.
  expect(tauri.invoke).not.toHaveBeenCalledWith("buddy_mini_set_expanded", { expanded: false });
  act(() => { host.querySelector(".buddy-mini")!.dispatchEvent(new Event("animationend", { bubbles: true })); });
  expect(tauri.invoke).toHaveBeenCalledWith("buddy_mini_set_expanded", { expanded: false });
  const bubble = host.querySelector<HTMLButtonElement>(".buddy-mini-bubble")!;
  // The conversation is not shown while collapsed.
  expect(host.querySelector(".conversation")).toBeNull();
  const pointer = (type: string, x: number) => act(() => { bubble.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, screenX: x, screenY: 10, button: 0 }), { pointerId: 1 })); });
  pointer("pointerdown", 10); pointer("pointermove", 30); pointer("pointerup", 30);
  expect(tauri.startDragging).toHaveBeenCalledOnce();
  expect(host.querySelector(".buddy-mini-bubble")).not.toBeNull();
  pointer("pointerdown", 10); pointer("pointerup", 10);
  expect(tauri.invoke).toHaveBeenLastCalledWith("buddy_mini_set_expanded", { expanded: true });
  await settle();
  expect(host.textContent).toContain("Talking to Chief");
});
