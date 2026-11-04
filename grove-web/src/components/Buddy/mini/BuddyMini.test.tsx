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
vi.mock("../../../context", () => ({ ConfigProvider: ({ children }: { children: unknown }) => children, useConfig: () => ({ config: { web: { buddy_motion: "standard" } } }) }));
vi.mock("../../../hooks/useShellAuth", () => ({ useShellAuth: () => ({ authReady: true, remoteServer: false }) }));
vi.mock("../../../hooks/useRadioEvents", () => ({ useRadioEvents: () => ({ radioClients: 0 }) }));
vi.mock("../BuddyConversation", () => ({ BuddyConversation: ({ buddy, open }: { buddy: { name: string }; open: boolean }) => <div className="conversation" data-open={open}>Talking to {buddy.name}</div> }));

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

it("opens as the avatar with nothing unread, and stays one when switched", async () => {
  act(() => root.render(<BuddyMini />));
  await settle();
  const bubble = () => host.querySelector(".buddy-mini-bubble");
  expect(host.querySelector(".buddy-mini")!.classList.contains("is-collapsed")).toBe(true);
  expect(host.querySelector(".conversation")!.getAttribute("data-open")).toBe("false");
  expect(bubble()).not.toBeNull();
  expect(bubble()!.classList.contains("is-unread")).toBe(false);
  expect(bubble()!.classList.contains("is-arriving")).toBe(true);
  act(() => { bubble()!.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName: "buddy-mini-arrive" })); });
  expect(bubble()!.classList.contains("is-arriving")).toBe(false);
  await act(async () => tauri.handlers.get("buddy-mini:show")!({ payload: "mock-inbox" }));
  await settle();
  expect(bubble()).not.toBeNull();
  expect(bubble()!.classList.contains("is-unread")).toBe(false);
  expect(bubble()!.classList.contains("is-arriving")).toBe(true);
});

it("collapses to the avatar bubble; a click expands it and a drag moves the window", async () => {
  act(() => root.render(<BuddyMini />));
  await settle();
  const press = (type: string) => act(() => { host.querySelector(".buddy-mini-bubble")!.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, screenX: 10, screenY: 10, button: 0 }), { pointerId: 1 })); });
  press("pointerdown"); press("pointerup");
  await settle();
  act(() => button("Collapse").click());
  // The panel shrinks into the corner first; the window follows when that ends.
  expect(tauri.invoke).not.toHaveBeenCalledWith("buddy_mini_set_expanded", { expanded: false });
  act(() => { host.querySelector(".buddy-mini")!.dispatchEvent(new Event("animationend", { bubbles: true })); });
  expect(tauri.invoke).toHaveBeenCalledWith("buddy_mini_set_expanded", { expanded: false });
  const bubble = host.querySelector<HTMLButtonElement>(".buddy-mini-bubble")!;
  // The conversation stays connected out of sight while collapsed.
  const conversation = host.querySelector<HTMLElement>(".conversation")!;
  expect(conversation.dataset.open).toBe("false");
  expect(host.querySelector(".buddy-mini")!.classList.contains("is-collapsed")).toBe(true);
  const pointer = (type: string, x: number) => act(() => { bubble.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, screenX: x, screenY: 10, button: 0 }), { pointerId: 1 })); });
  pointer("pointerdown", 10); pointer("pointermove", 30); pointer("pointerup", 30);
  expect(tauri.startDragging).toHaveBeenCalledOnce();
  expect(host.querySelector(".buddy-mini-bubble")).not.toBeNull();
  pointer("pointerdown", 10); pointer("pointerup", 10);
  expect(tauri.invoke).toHaveBeenLastCalledWith("buddy_mini_set_expanded", { expanded: true });
  await settle();
  // Reopening shows the same live conversation, not a fresh load.
  expect(host.querySelector(".conversation")).toBe(conversation);
  expect(conversation.dataset.open).toBe("true");
  expect(host.querySelector(".buddy-mini")!.classList.contains("is-collapsed")).toBe(false);
});
