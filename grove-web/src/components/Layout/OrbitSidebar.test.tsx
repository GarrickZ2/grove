import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitSidebar } from "./OrbitSidebar";
import { BuddyLaunchContext } from "../Buddy/buddyLaunchContext";
import { createBuddiesMock } from "../../api/buddies.mock";
import { archiveChat, createChat, listChats, reorderTasks, updateChatTitle } from "../../api";
import type { NodeStatus } from "../../api/walkieTalkie";

const project = vi.hoisted(() => ({ id: "p1", projectType: "studio", localTask: { id: "_local" }, tasks: [{ id: "task-a", name: "Task A", status: "active" }] }));
const radio = vi.hoisted(() => ({ callbacks: {} as { onEvent?: (event: unknown) => void; onChatStatus?: (project: string, task: string, chat: string, status: NodeStatus) => void; onChatListChanged?: (project: string, task: string) => void } }));
const visibleChat = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("../Tasks/TaskView/useActiveChatId", () => ({ useGlobalActiveChatId: () => visibleChat.id }));
vi.mock("../../api", () => ({ listChats: vi.fn(), createChat: vi.fn(), updateChatTitle: vi.fn(), renameTask: vi.fn(), archiveTask: vi.fn(), deleteTask: vi.fn(), archiveChat: vi.fn(), deleteChat: vi.fn(), reorderTasks: vi.fn() }));
const refreshSelectedProject = vi.hoisted(() => async () => {});
vi.mock("../../context", () => ({
  useProject: () => ({ selectedProject: project, refreshSelectedProject }),
  useNotifications: () => ({ unreadCount: 0 }),
  useTheme: () => ({ appIcon: "orbit", theme: { isLight: true } }),
}));
vi.mock("../../hooks", () => ({ useRadioEvents: (callbacks: typeof radio.callbacks) => { radio.callbacks = callbacks; } }));
vi.mock("../../hooks/useRadioEvents", () => ({ refreshRadioActivity: vi.fn() }));
vi.mock("../../hooks/useIsMobile", () => ({ useIsMobile: () => ({ isMobile: false, isTouchDevice: false }) }));
vi.mock("./OrbitProjectSelector", () => ({ OrbitProjectSelector: () => <div>Project selector</div> }));
vi.mock("./OrbitNotificationPopover", () => ({ OrbitNotificationPopover: () => null }));
vi.mock("../ui/DialogShell", () => ({ DialogShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../Dialogs", () => ({ ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>Confirm deletion</button> }));

const chat = (id: string, title: string) => ({ id, title, agent: "agent", created_at: "", history_path: "", launch_mode: "acp" });

describe("Orbit sidebar", () => {
  const navigate = vi.fn();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    localStorage.clear();
    project.id = "p1";
    visibleChat.id = null;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(listChats).mockImplementation(async (_project, task) => task === "_local" ? [chat("work-chat", "Work conversation")] : [chat("task-chat", "Task conversation")]);
    vi.mocked(createChat).mockResolvedValue(chat("new-chat", "New Chat"));
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
  it("opens Buddies from desktop and mobile drawer entries and shows waiting attention", async () => {
    const click = vi.fn();
    for (const drawer of [false, true]) {
      await act(async () => root.render(<BuddyLaunchContext.Provider value={{ items: createBuddiesMock().list(), open: vi.fn() }}><OrbitSidebar variant={drawer ? "drawer" : undefined} activeItem="dashboard" collapsed={false} onCollapse={vi.fn()} onItemClick={click} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} /></BuddyLaunchContext.Provider>));
      const entry = container.querySelector<HTMLButtonElement>('.orbit-footer [aria-label="Buddies"]')!;
      expect(entry.querySelector('[aria-label="Buddies need approval"]')).not.toBeNull();
      expect(container.querySelector(".orbit-footer")?.firstElementChild).toBe(entry);
      expect(entry.querySelector(".lucide-sprout")).not.toBeNull();
      const settings = [...container.querySelectorAll<HTMLButtonElement>(".orbit-footer button")].find(button => button.textContent === "Settings")!;
      const connect = container.querySelector<HTMLButtonElement>('.orbit-footer [aria-label="IM Connect"]')!;
      expect(settings.parentElement).toBe(connect.parentElement);
      expect(connect.parentElement?.className).toBe("orbit-footer-actions");
      act(() => entry.click());
      expect(click).toHaveBeenLastCalledWith("buddies");
    }
    expect(click).toHaveBeenCalledTimes(2);
  });
  it("lists Work sessions directly, groups task sessions, and opens the correct task", async () => {
    await act(async () => root.render(<OrbitSidebar activeItem="dashboard" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    expect(container.textContent).toContain("Work conversation");
    expect(container.textContent).not.toContain("Task conversation");
    const navigationButtons = [...container.querySelectorAll("nav button")];
    expect(navigationButtons.slice(0, 2).map((button) => button.textContent)).toEqual(["New", "Dashboard"]);
    const folder = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Task A"))!;
    expect(folder.querySelector(".lucide-folder")).toBeTruthy();
    expect(folder.querySelector(".lucide-chevron-right")).toBeNull();
    act(() => folder.click());
    expect(folder.querySelector(".lucide-folder-open")).toBeTruthy();
    expect(folder.querySelector(".lucide-chevron-down")).toBeNull();
    const taskChat = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Task conversation"))!;
    act(() => taskChat.click());
    expect(navigate).toHaveBeenCalledWith("tasks", { taskId: "task-a", chatId: "task-chat", viewMode: "terminal" });
    const newChat = [...container.querySelectorAll("button")].find((button) => button.textContent === "New")!;
    await act(async () => newChat.click());
    // New opens the draft page; the Session is only created on first send.
    expect(createChat).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("new", { taskId: "_local" });
  });
  it("opens task creation from the Tasks section", async () => {
    await act(async () => root.render(<OrbitSidebar activeItem="dashboard" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    act(() => container.querySelector<HTMLButtonElement>('.orbit-task-section-heading [aria-label="New task"]')!.click());
    expect(navigate).toHaveBeenCalledWith("tasks", { openNewTask: true });
    // Sessions has the same toggle above it, so pick the Tasks one by label.
    const toggle = [...container.querySelectorAll<HTMLButtonElement>(".orbit-task-section-toggle")].find((button) => button.textContent === "Tasks")!;
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Task A");
  });
  it("opens a new chat with the corresponding task selected", async () => {
    await act(async () => root.render(<OrbitSidebar activeItem="new" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="New chat in Task A"]')!.click());
    expect(navigate).toHaveBeenCalledWith("new", { taskId: "task-a" });
    expect(createChat).not.toHaveBeenCalled();
  });
  it("restores section and folder expansion separately for each project", async () => {
    const render = () => root.render(<OrbitSidebar activeItem="new" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />);
    const section = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".orbit-task-section-toggle")].find((button) => button.textContent === name)!;
    const folder = () => container.querySelector<HTMLButtonElement>(".orbit-task-toggle")!;
    await act(async () => render());
    expect(folder().getAttribute("aria-expanded")).toBe("false");
    act(() => folder().click());
    act(() => section("Sessions").click());
    act(() => section("Tasks").click());
    project.id = "p2";
    await act(async () => render());
    expect(section("Sessions").getAttribute("aria-expanded")).toBe("true");
    expect(section("Tasks").getAttribute("aria-expanded")).toBe("true");
    expect(folder().getAttribute("aria-expanded")).toBe("false");
    project.id = "p1";
    await act(async () => render());
    expect(section("Sessions").getAttribute("aria-expanded")).toBe("false");
    expect(section("Tasks").getAttribute("aria-expanded")).toBe("false");
    act(() => section("Tasks").click());
    expect(folder().getAttribute("aria-expanded")).toBe("true");
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => render());
    expect(section("Sessions").getAttribute("aria-expanded")).toBe("false");
    expect(folder().getAttribute("aria-expanded")).toBe("true");
  });
  it("reconciles running indicators from snapshots and subsequent status events", async () => {
    await act(async () => root.render(<OrbitSidebar activeItem="tasks" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    act(() => container.querySelector<HTMLButtonElement>(".orbit-task-toggle")!.click());
    const session = () => [...container.querySelectorAll<HTMLButtonElement>(".orbit-session")].find((button) => button.textContent?.includes("Task conversation"))!;
    act(() => radio.callbacks.onEvent?.({ type: "activity_snapshot", chats: [{ project_id: "p1", task_id: "task-a", chat_id: "task-chat", status: "busy" }] }));
    expect(session().querySelector('[aria-label="busy"]')).toBeTruthy();
    act(() => radio.callbacks.onChatStatus?.("p1", "task-a", "task-chat", "idle"));
    expect(session().querySelector(".orbit-status.is-completed")).toBeTruthy();
    act(() => radio.callbacks.onChatStatus?.("p1", "task-a", "task-chat", "busy"));
    act(() => radio.callbacks.onEvent?.({ type: "activity_snapshot", chats: [] }));
    expect(session().querySelector(".orbit-status")).toBeNull();
  });
  it("clears completion when viewed, but shows it on other pages even with a remembered active chat", async () => {
    const render = (page: string) => root.render(<OrbitSidebar activeItem={page} collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />);
    const status = (value: NodeStatus) => radio.callbacks.onChatStatus?.("p1", "_local", "work-chat", value);
    visibleChat.id = "work-chat";
    await act(async () => render("dashboard"));
    act(() => { status("busy"); status("idle"); });
    expect(container.querySelector(".is-completed")).toBeTruthy();
    await act(async () => render("tasks"));
    expect(container.querySelector(".is-completed")).toBeNull();
    await act(async () => render("dashboard"));
    act(() => status("idle"));
    expect(container.querySelector(".is-completed")).toBeNull();
    await act(async () => render("tasks"));
    act(() => status("busy"));
    expect(container.querySelector('[aria-label="busy"]')).toBeTruthy();
    act(() => status("idle"));
    await act(async () => render("dashboard"));
    expect(container.querySelector(".is-completed")).toBeNull();
  });
  it("hides input dots only while viewing the session and keeps forms orange after the turn finishes", async () => {
    const render = (page = "tasks") => root.render(<OrbitSidebar activeItem={page} collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />);
    const status = (value: NodeStatus) => radio.callbacks.onChatStatus?.("p1", "_local", "work-chat", value);
    const input = (waiting: boolean) => radio.callbacks.onEvent?.({ type: "chat_input_status", project_id: "p1", task_id: "_local", chat_id: "work-chat", waiting_for_input: waiting });
    await act(async () => render());
    act(() => status("permission_required"));
    expect(container.querySelector(".is-waiting")).toBeTruthy();
    visibleChat.id = "work-chat";
    await act(async () => render());
    expect(container.querySelector(".orbit-status")).toBeNull();
    await act(async () => render("dashboard"));
    expect(container.querySelector(".is-waiting")).toBeTruthy();
    act(() => { status("busy"); input(true); status("idle"); });
    expect(container.querySelector(".is-waiting")).toBeTruthy();
    expect(container.querySelector(".is-completed")).toBeNull();
    await act(async () => render());
    expect(container.querySelector(".orbit-status")).toBeNull();
    visibleChat.id = "another-chat";
    await act(async () => render());
    expect(container.querySelector(".is-waiting")).toBeTruthy();
    act(() => input(false));
    expect(container.querySelector(".orbit-status")).toBeNull();
  });
  it("restores form attention from a snapshot without marking an initially idle session complete", async () => {
    await act(async () => root.render(<OrbitSidebar activeItem="dashboard" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    const snapshot = (waiting: boolean) => radio.callbacks.onEvent?.({ type: "activity_snapshot", chats: [{ project_id: "p1", task_id: "_local", chat_id: "work-chat", status: "idle", waiting_for_input: waiting }] });
    act(() => snapshot(false));
    expect(container.querySelector(".orbit-status")).toBeNull();
    act(() => snapshot(true));
    expect(container.querySelector(".is-waiting")).toBeTruthy();
    act(() => snapshot(false));
    expect(container.querySelector(".orbit-status")).toBeNull();
  });
  it("keeps the newest session order when refresh requests finish out of order", async () => {
    let resolveOlder!: (chats: ReturnType<typeof chat>[]) => void;
    let resolveNewer!: (chats: ReturnType<typeof chat>[]) => void;
    await act(async () => root.render(<OrbitSidebar activeItem="new" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    act(() => container.querySelector<HTMLButtonElement>(".orbit-task-toggle")!.click());
    vi.mocked(listChats).mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewer = resolve; }));
    act(() => { radio.callbacks.onChatListChanged?.("p1", "task-a"); radio.callbacks.onChatListChanged?.("p1", "task-a"); });
    await act(async () => resolveNewer([chat("b", "Recent"), chat("a", "Older")]));
    await act(async () => resolveOlder([chat("a", "Older"), chat("b", "Recent")]));
    expect([...container.querySelectorAll(".orbit-session-nested")].map((button) => button.textContent)).toEqual(["Recent", "Older"]);
  });
  it("immediately moves the session with local activity to the top of its task", async () => {
    vi.mocked(listChats).mockImplementation(async (_project, task) => task === "task-a" ? [chat("a", "First"), chat("b", "Second")] : []);
    await act(async () => root.render(<OrbitSidebar activeItem="tasks" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    act(() => container.querySelector<HTMLButtonElement>(".orbit-task-toggle")!.click());
    const titles = () => [...container.querySelectorAll(".orbit-session-nested")].map((button) => button.textContent);
    act(() => window.dispatchEvent(new CustomEvent("grove:session-local-activity", { detail: { projectId: "other", taskId: "task-a", chatId: "b" } })));
    expect(titles()).toEqual(["First", "Second"]);
    act(() => window.dispatchEvent(new CustomEvent("grove:session-local-activity", { detail: { projectId: "p1", taskId: "task-a", chatId: "b" } })));
    expect(titles()).toEqual(["Second", "First"]);
  });
  it("uses the configured icon and offers session and task actions", async () => {
    await act(async () => root.render(<OrbitSidebar activeItem="dashboard" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    expect(container.querySelector(".orbit-brand img")?.getAttribute("src")).toBe("/app-icons/orbit-light.svg");
    const menu = container.querySelector<HTMLButtonElement>('[aria-label="More actions for Work conversation"]')!;
    act(() => menu.click());
    expect(navigate).not.toHaveBeenCalled();
    const rename = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Rename')!;
    act(() => rename.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(input, "Renamed session"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(updateChatTitle).toHaveBeenCalledWith("p1", "_local", "work-chat", "Renamed session");
    const taskMenu = container.querySelector<HTMLButtonElement>('[aria-label="More actions for Task A"]');
    expect(taskMenu).toBeTruthy();
  });
  it("keeps menus available on selected rows and targets other sessions without selecting them", async () => {
    vi.mocked(listChats).mockImplementation(async (_project, task) => task === '_local' ? [chat('a', 'First'), chat('b', 'Second')] : []);
    await act(async () => root.render(<OrbitSidebar activeItem="tasks" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    act(() => container.querySelector<HTMLButtonElement>('.orbit-session')!.click());
    navigate.mockClear();
    expect(container.querySelector('.orbit-session-row.is-selected [aria-label="More actions for First"]')).toBeTruthy();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="More actions for Second"]')!.click());
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector('.orbit-session-row.is-selected')?.textContent).toContain('First');
    const archive = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Archive')!;
    await act(async () => archive.click());
    expect(archiveChat).toHaveBeenCalledWith('p1', '_local', 'b');
    expect(navigate).not.toHaveBeenCalled();
  });
  it("reorders tasks by dragging a task row onto another task", async () => {
    const original = project.tasks;
    project.tasks = [{ id: "task-a", name: "Task A", status: "active" }, { id: "task-b", name: "Task B", status: "active" }];
    // Hold the request open: once it settles the order comes from the (mocked, unchanged) project refresh.
    vi.mocked(reorderTasks).mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<OrbitSidebar activeItem="dashboard" collapsed={false} onCollapse={vi.fn()} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    const names = () => [...container.querySelectorAll(".orbit-task-toggle")].map((button) => button.textContent);
    const drag = (target: Element, type: string) => {
      // jsdom has no DragEvent; React only needs the type and a dataTransfer.
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { setData: vi.fn(), effectAllowed: "", dropEffect: "" } });
      target.dispatchEvent(event);
    };
    const [rowA, rowB] = [...container.querySelectorAll(".orbit-task-row")];
    expect(rowA.getAttribute("draggable")).toBe("true");
    act(() => drag(rowA, "dragstart"));
    // jsdom reports zero-size rects, so the drop lands in the lower half: after Task B.
    act(() => drag(rowB, "dragover"));
    expect(rowB.parentElement?.classList.contains("is-drop-after")).toBe(true);
    await act(async () => drag(rowB, "drop"));
    expect(reorderTasks).toHaveBeenCalledWith("p1", ["task-b", "task-a"]);
    expect(names()).toEqual(["Task B", "Task A"]);
    project.tasks = original;
  });
  it("replaces the collapsed sidebar with title-bar controls", async () => {
    const onCollapse = vi.fn();
    await act(async () => root.render(<OrbitSidebar activeItem="dashboard" collapsed onCollapse={onCollapse} onItemClick={vi.fn()} onNavigate={navigate} onSearch={vi.fn()} onProjectSwitch={vi.fn()} onManageProjects={vi.fn()} onAddProject={vi.fn()} />));
    expect(container.querySelector(".orbit-sidebar")?.classList.contains("is-collapsed")).toBe(true);
    expect(container.querySelector('[aria-label="Sessions"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]')!.click());
    expect(onCollapse).toHaveBeenCalledOnce();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="New task"]')!.click());
    expect(navigate).toHaveBeenCalledWith("tasks", { openNewTask: true });
  });
});
