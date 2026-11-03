import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChat } from "../../api";
import { OrbitNewChat } from "./OrbitNewChat";

vi.mock("../../api", () => ({ createChat: vi.fn(), listChats: vi.fn() }));
vi.mock("../../api/marketplace", () => ({
  listInstalledAgentConfigs: vi.fn(async () => [{ id: "codex-acp", name: "Codex" }]),
}));
const projectState = vi.hoisted(() => ({ type: "repo" }));
const recent = vi.hoisted(() => ({ sessions: [] as unknown[] }));
vi.mock("../../orbit/dashboard/useRecentSessions", () => ({ useRecentSessions: () => ({ sessions: recent.sessions, loaded: true }) }));
vi.mock("../../orbit/dashboard/useLiveChats", () => ({ useLiveChats: () => ({ "project:t1:c1": { status: "busy" } }) }));
vi.mock("../../context", () => {
  const project = () => ({ id: "project", name: "Project", exists: true, projectType: projectState.type, localTask: { id: "_local" }, tasks: [{ id: "t1", name: "Fix login", status: "live" }] });
  return {
    useProject: () => ({ projects: [project()], selectedProject: project(), selectProject: vi.fn() }),
    useTheme: () => ({ theme: { accentPalette: ["#3370ff"] } }),
  };
});
vi.mock("../../hooks", () => ({ useIsMobile: () => ({ isMobile: false }) }));
vi.mock("../Tasks/TaskView/useACPAvailability", () => ({
  useACPAvailability: () => ({ baseAgents: [], customAgents: [], customAgentPersonas: [], acpAvailabilityLoaded: true }),
}));
vi.mock("../Tasks/TaskView/ChatConfigMenus", () => ({ DropdownSelect: () => null, SessionSettingsMenu: () => null }));
vi.mock("../Tasks/TaskView/composer/useMentionSources", () => ({
  useMentionSources: () => ({ items: [], browserTabs: [], browserTabsAvailable: false, studio: false, refresh: vi.fn(), loadBrowserTabs: vi.fn() }),
}));
vi.mock("../Tasks/TaskView/useInitialChatLoad", () => ({ buildDefaultSessionTitle: () => "New Chat" }));

describe("Orbit New starter prompts", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(createChat).mockReset();
    localStorage.clear();
    projectState.type = "repo";
    recent.sessions = [];
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

  it("fills the composer without sending, and stays in place (dimmed) while there is text", async () => {
    await act(async () => root.render(<OrbitNewChat onNavigate={vi.fn()} />));
    expect(starters().length).toBe(3);
    act(() => starters()[1].click());
    expect(host.querySelector('[role="textbox"]')!.textContent).toBe("Find and fix a failing test");
    expect(localStorage.getItem("grove-orbit-new-draft-html")).toBe("Find and fix a failing test");
    expect(createChat).not.toHaveBeenCalled();
    expect(starters().length).toBe(3);
    expect(host.querySelector(".orbit-new__starters")!.classList.contains("is-quiet")).toBe(true);
  });

  it("offers Studio starters in a Studio project", async () => {
    projectState.type = "studio";
    await act(async () => root.render(<OrbitNewChat onNavigate={vi.fn()} />));
    expect(starters().map((b) => b.textContent)).toContain("Summarize the workspace instructions");
  });

  it("lists recent Sessions under Continue, with a live dot, and opens one", async () => {
    const now = Date.now();
    recent.sessions = [
      { taskId: "t1", chat: { id: "c1", title: "Fix the login form", agent: "claude", created_at: "" }, activeAt: now - 120_000 },
      { taskId: "_local", chat: { id: "c2", title: "Docs pass", agent: "codex", created_at: "" }, activeAt: now - 3_600_000 },
    ];
    const onNavigate = vi.fn();
    await act(async () => root.render(<OrbitNewChat onNavigate={onNavigate} />));
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>(".orbit-new__continue button"));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("Fix login");
    expect(rows[0].querySelector('[aria-label="Running"]')).not.toBeNull();
    expect(rows[1].textContent).toContain("Main checkout");
    expect(rows[1].querySelector('[aria-label="Running"]')).toBeNull();
    act(() => rows[0].click());
    expect(onNavigate).toHaveBeenCalledWith("tasks", { taskId: "t1", chatId: "c1", viewMode: "terminal" });
  });

  it("hides Continue when there are no Sessions", async () => {
    await act(async () => root.render(<OrbitNewChat onNavigate={vi.fn()} />));
    expect(host.querySelector(".orbit-new__continue")).toBeNull();
  });

  it("stays away once a first message was sent", async () => {
    localStorage.setItem("grove:firstrun.starters", "1");
    await act(async () => root.render(<OrbitNewChat onNavigate={vi.fn()} />));
    expect(starters().length).toBe(0);
  });
});
