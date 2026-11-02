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
  const project = { id: "project", name: "Project", exists: true, projectType: "repo", localTask: { id: "_local" }, tasks: [] };
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

describe("Orbit New starter prompts", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(createChat).mockReset();
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  const starters = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".orbit-new__starter"));

  it("fills the composer without sending, then hides while there is text", async () => {
    await act(async () => root.render(<OrbitNewChat onNavigate={vi.fn()} />));
    expect(starters().length).toBe(3);
    act(() => starters()[1].click());
    expect(host.querySelector("textarea")!.value).toBe("Find and fix a failing test");
    expect(localStorage.getItem("grove-orbit-new-draft")).toBe("Find and fix a failing test");
    expect(createChat).not.toHaveBeenCalled();
    expect(starters().length).toBe(0);
  });

  it("stays away once a first message was sent", async () => {
    localStorage.setItem("grove:firstrun.starters", "1");
    await act(async () => root.render(<OrbitNewChat onNavigate={vi.fn()} />));
    expect(starters().length).toBe(0);
  });
});
