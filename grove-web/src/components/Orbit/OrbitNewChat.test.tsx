import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChat } from "../../api";
import { OrbitNewChat } from "./OrbitNewChat";

vi.mock("../../api", () => ({ createChat: vi.fn(), listChats: vi.fn() }));
vi.mock("../../api/marketplace", () => ({
  listInstalledAgentConfigs: vi.fn(async () => [{ id: "codex-acp", name: "Codex" }]),
}));
vi.mock("../../context", () => {
  const project = { id: "project", name: "Project", exists: true, localTask: { id: "_local" }, tasks: [] };
  return {
    useProject: () => ({ projects: [project], selectedProject: project, selectProject: vi.fn() }),
    useTheme: () => ({ theme: { accentPalette: ["#3370ff"] } }),
  };
});
vi.mock("../../hooks", () => ({ useIsMobile: () => ({ isMobile: false }) }));
vi.mock("../Tasks/TaskView/useACPAvailability", () => ({
  useACPAvailability: () => ({ baseAgents: [], customAgents: [], customAgentPersonas: [], acpAvailabilityLoaded: true }),
}));
vi.mock("../Tasks/TaskView/ChatConfigMenus", () => ({ DropdownSelect: () => null, SessionSettingsMenu: () => null }));
vi.mock("../Tasks/TaskView/useInitialChatLoad", () => ({ buildDefaultSessionTitle: () => "New Chat" }));

describe("Orbit New composer Enter handling", () => {
  let host: HTMLDivElement;
  let root: Root;
  let input: HTMLTextAreaElement;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.mocked(createChat).mockReset();
    localStorage.clear();
    localStorage.setItem("grove-orbit-new-draft", "你好");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<OrbitNewChat onNavigate={vi.fn()} />));
    input = host.querySelector("textarea")!;
    expect(host.querySelector<HTMLButtonElement>('button[title="Send (Enter)"]')!.disabled).toBe(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function enter(init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    act(() => { input.dispatchEvent(event); });
    return event;
  }

  it("does not send when Enter confirms an active IME composition", () => {
    const event = enter({ isComposing: true });
    expect(createChat).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe("你好");
  });

  it("does not send the WebKit IME confirmation Enter with keyCode 229 and isComposing false", () => {
    const event = enter({ keyCode: 229, isComposing: false });
    expect(createChat).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe("你好");
    expect(localStorage.getItem("grove-orbit-new-draft")).toBe("你好");

    // The next deliberate Enter still sends the composed message.
    expect(enter().defaultPrevented).toBe(true);
    expect(createChat).toHaveBeenCalledOnce();
  });

  it("keeps Shift+Enter available for a newline", () => {
    expect(enter({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(createChat).not.toHaveBeenCalled();
  });
});
