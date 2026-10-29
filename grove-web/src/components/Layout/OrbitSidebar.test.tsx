import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitSidebar } from "./OrbitSidebar";
import { archiveChat, createChat, listChats, updateChatTitle } from "../../api";

vi.mock("../../api", () => ({ listChats: vi.fn(), createChat: vi.fn(), updateChatTitle: vi.fn(), renameTask: vi.fn(), archiveTask: vi.fn(), deleteTask: vi.fn(), archiveChat: vi.fn(), deleteChat: vi.fn() }));
vi.mock("../../context", () => ({
  useProject: () => ({ selectedProject: { id: "p1", projectType: "studio", localTask: { id: "_local" }, tasks: [{ id: "task-a", name: "Task A", status: "active" }] } }),
  useNotifications: () => ({ unreadCount: 0 }),
  useTheme: () => ({ appIcon: "orbit", theme: { isLight: true } }),
}));
vi.mock("../../hooks", () => ({ useRadioEvents: vi.fn() }));
vi.mock("./ProjectSelector", () => ({ ProjectSelector: () => <div>Project selector</div> }));
vi.mock("./NotificationPopover", () => ({ NotificationPopover: () => null }));
vi.mock("../ui/DialogShell", () => ({ DialogShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../Dialogs", () => ({ ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>Confirm deletion</button> }));

const chat = (id: string, title: string) => ({ id, title, agent: "agent", created_at: "", history_path: "", launch_mode: "acp" });

describe("Orbit sidebar", () => {
  const navigate = vi.fn();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(listChats).mockImplementation(async (_project, task) => task === "_local" ? [chat("work-chat", "Work conversation")] : [chat("task-chat", "Task conversation")]);
    vi.mocked(createChat).mockResolvedValue(chat("new-chat", "New Chat"));
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
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
