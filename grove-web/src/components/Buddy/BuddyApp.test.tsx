vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "true"));
import { listInstalledAgentConfigs } from "../../api/marketplace";
vi.mock("../../api/marketplace", () => ({ listInstalledAgentConfigs: vi.fn() }));
vi.mock("../../hooks/useAgentCatalogRevision", () => ({ useAgentCatalogRevision: () => 0 }));
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuddyApp } from "./BuddyApp";
import { createBuddiesMock } from "../../api/buddies.mock";
import { buddyAgentFixtures } from "../../api/buddies.testFixtures";
import * as api from "../../api/buddies";
import { createBuddyRoutine } from "../../api/buddyResources";
vi.mock("../../api/buddyResources", () => ({ createBuddyRoutine: vi.fn() }));

vi.mock("../../api/buddies", () => ({ listBuddies: vi.fn(), getBuddy: vi.fn(), createBuddy: vi.fn(), archiveBuddy: vi.fn(), reorderBuddies: vi.fn() }));
vi.mock("./BuddyConversation", () => ({ BuddyConversation: ({ buddy }: { buddy: { name: string } }) => <div>Say hi to {buddy.name}</div> }));
vi.mock("./BuddySidePanel/BuddySidePanel", () => ({ BuddySidePanel: ({ onClose }: { onClose: () => void }) => <aside aria-label="Buddy panel"><button aria-label="Close panel" onClick={onClose}>Close</button></aside> }));
vi.mock("../../context", () => ({ useConfig: () => ({ config: { acp: { agent_command: "claude-code" } } }) }));
vi.mock("../Config/SettingsPage", () => ({ SettingsPage: () => <div>Global settings content</div> }));
vi.mock("../ui/DialogShell", () => ({ DialogShell: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) => isOpen ? <div role="dialog">{children}</div> : null }));
vi.mock("../../keyboard/useEscapeScope", () => ({ useEscapeScope: () => {} }));

describe("Buddy shell and creation", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    localStorage.clear();
    const mock = createBuddiesMock();
    vi.mocked(api.listBuddies).mockImplementation(async () => mock.list());
    vi.mocked(api.getBuddy).mockImplementation(async (id) => mock.get(id));
    vi.mocked(api.createBuddy).mockImplementation(async (input) => mock.create(input));
    vi.mocked(api.archiveBuddy).mockImplementation(async (id) => mock.archive(id));
    vi.mocked(api.reorderBuddies).mockImplementation(async (ids) => mock.reorder(ids));
    vi.mocked(listInstalledAgentConfigs).mockImplementation(async () => buddyAgentFixtures());
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root.render(<BuddyApp />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label)!;
  const input = (element: HTMLInputElement, value: string) => act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });

  it("selects a Buddy, persists selection and filters by role", async () => {
    const row = [...host.querySelectorAll<HTMLButtonElement>(".buddy-list-item")].find((node) => node.textContent?.includes("Release Captain"))!;
    await act(async () => row.click());
    expect(localStorage.getItem("grove-buddy-selected")).toBe("mock-release");
    expect(host.textContent).toContain("Say hi to Release Captain");
    expect(host.querySelector('input[aria-label="Search Buddies"]')).toBeNull();
  });

  it("creates a Buddy with the global default Agent and chosen avatar", async () => {
    await act(async () => button("Create Buddy").click());
    const name = host.querySelector<HTMLFormElement>('form[aria-label="Create Buddy"]')!.querySelector<HTMLInputElement>("input")!;
    input(name, "Docs Partner");
    act(() => button("drop avatar").click());
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(api.createBuddy).toHaveBeenCalledWith(expect.objectContaining({ name: "Docs Partner", agent: "claude-code", avatar: expect.stringContaining('"shape":"drop"') }));
    expect(host.textContent).toContain("Say hi to Docs Partner");
  });

  it("opens and closes the reused global settings page", () => {
    act(() => button("Settings").click());
    expect(host.textContent).toContain("Global settings content");
    act(() => button("Close Grove settings").click());
    expect(host.textContent).not.toContain("Global settings content");
  });
  it("labels the return action Grove and reserves native macOS titlebar clearance", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const exit = vi.fn();
    try {
      await act(async () => root.render(<BuddyApp onExit={exit} />));
      expect(host.querySelector(".buddy-app.has-mac-controls")).not.toBeNull();
      const back = button("Back to Grove");
      expect(back.textContent).toBe("Grove");
      expect(back.title).toBe("Back to Grove");
      act(() => back.click());
      expect(exit).toHaveBeenCalledOnce();
    } finally { platform.mockRestore(); }
  });

  it("requires confirmation to archive and explains retained data", async () => {
    act(() => host.querySelector(".buddy-list-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    act(() => button("Archive Buddy").click());
    expect(api.archiveBuddy).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Routines and IM connections will not stop automatically");
    await act(async () => button("Archive Buddy").click());
    expect(api.archiveBuddy).toHaveBeenCalledWith("mock-chief");
    expect(host.querySelectorAll(".buddy-list-item")).toHaveLength(2);
  });

  it("reorders using the full list even when filtering", async () => {
    const rows = host.querySelectorAll(".buddy-list-item");
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: { setData: vi.fn() } });
    act(() => rows[2].dispatchEvent(event));
    await act(async () => rows[0].dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })));
    expect(api.reorderBuddies).toHaveBeenCalledWith(["mock-inbox", "mock-chief", "mock-release"]);
  });
  const atWidth = async (width: number) => {
    act(() => root.unmount()); vi.stubGlobal("innerWidth", width); root = createRoot(host);
    await act(async () => root.render(<BuddyApp />));
  };
  it.each([0, 1, 3])("exposes native and fallback titlebar dragging with %i Buddies while keeping controls clickable", async (count) => {
    vi.mocked(api.listBuddies).mockResolvedValue(createBuddiesMock().list().slice(0, count));
    await atWidth(1280);
    const exit = vi.fn();
    await act(async () => root.render(<BuddyApp onExit={exit} />));
    const regions = host.querySelectorAll(".buddy-zero-header, .buddy-conversation-header, .buddy-sidebar-top");
    expect(regions).toHaveLength(count >= 2 ? 2 : 1);
    for (const region of regions) {
      expect(region.getAttribute("data-tauri-drag-region")).toBe("deep");
      expect(region.hasAttribute("data-window-drag-strip")).toBe(true);
      expect(region.querySelector("button[data-tauri-drag-region]")).toBeNull();
    }
    expect(host.querySelector(".buddy-main")?.hasAttribute("data-window-drag-strip")).toBe(false);
    act(() => button("Back to Grove").click());
    expect(exit).toHaveBeenCalledOnce();
    if (count === 0) {
      act(() => button("Grove settings").click());
      expect(host.textContent).toContain("Global settings content");
    } else {
      act(() => button("Open Buddy panel").click());
      expect(host.querySelector('[aria-label="Buddy panel"]')).not.toBeNull();
      if (count === 1) {
        act(() => button("Switch Buddy").click());
        expect(button("Switch Buddy").getAttribute("aria-expanded")).toBe("true");
      }
    }
  });
  it("uses phone list/conversation navigation and a separate bottom sheet", async () => {
    await atWidth(390);
    expect(host.querySelector(".buddy-app.is-phone")).not.toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Buddies");
    expect(host.querySelector(".is-conversation-open")).toBeNull();
    expect(host.querySelector<HTMLElement>(".buddy-list .buddy-av")?.style.width).toBe("44px");
    await act(async () => host.querySelector<HTMLButtonElement>(".buddy-list-item")!.click());
    expect(host.querySelector(".is-conversation-open")).not.toBeNull();
    expect(host.querySelector<HTMLElement>(".buddy-conversation-header .buddy-av")?.style.width).toBe("30px");
    expect(host.querySelector('[aria-label="Buddy panel"]')).toBeNull();
    act(() => button("Open Buddy panel").click());
    expect(host.querySelector('.buddy-sheet [aria-label="Buddy panel"]')).not.toBeNull();
    act(() => button("Close panel").click());
    expect(host.querySelector('[aria-label="Buddy panel"]')).toBeNull();
    act(() => button("Back to Buddies").click());
    expect(host.querySelector(".is-conversation-open")).toBeNull();
  });
  it("keeps tablet desktop navigation and defaults the panel closed", async () => {
    await atWidth(900);
    expect(host.querySelector(".is-phone")).toBeNull();
    expect(host.querySelector('[aria-label="Back to Buddies"]')).toBeNull();
    expect(host.querySelector('[aria-label="Buddy panel"]')).toBeNull();
    act(() => button("Open Buddy panel").click());
    expect(host.querySelector('[aria-label="Buddy panel"]')).not.toBeNull();
    expect(host.querySelector(".buddy-sheet")).toBeNull();
    expect(localStorage.getItem("grove-buddy-panel-open")).toBe("true");
  });

  it("shows onboarding for zero Buddies and preserves a created Buddy if its template routine fails", async () => {
    vi.mocked(api.listBuddies).mockResolvedValue([]);
    await atWidth(1280);
    expect(host.querySelector(".buddy-sidebar")).toBeNull();
    expect(host.textContent).toContain("Start with a Buddy");
    await act(async () => host.querySelector<HTMLButtonElement>(".buddy-template")!.click());
    expect(host.querySelector<HTMLInputElement>('form input')?.value).toBe("Release Captain");
    vi.mocked(createBuddyRoutine).mockRejectedValue(new Error("Routine unavailable"));
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain("Buddy created. Routine could not be added");
    expect(api.createBuddy).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".buddy-switcher")).not.toBeNull();
    act(() => button("Done").click());
    act(() => button("Switch Buddy").click());
    act(() => button("Browse templates").click());
    expect(host.querySelectorAll(".buddy-template")).toHaveLength(4);
  });

  it("changes from a sidebar to a switcher when archiving down to one Buddy", async () => {
    for (let i = 0; i < 2; i++) {
      act(() => host.querySelector(".buddy-list-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
      act(() => button("Archive Buddy").click());
      await act(async () => button("Archive Buddy").click());
    }
    expect(host.querySelector(".buddy-sidebar")).toBeNull();
    expect(host.querySelector(".buddy-switcher")).not.toBeNull();
  });
});
