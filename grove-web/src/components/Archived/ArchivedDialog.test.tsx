import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchivedDialog } from "./ArchivedDialog";
import { deleteChat, listArchivedChats, listTasks, recoverTask, restoreChat } from "../../api";

const project = vi.hoisted(() => ({ id: "p1", tasks: [{ id: "task-a", name: "Task A", status: "active" }] }));
const refreshSelectedProject = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../api", () => ({ listTasks: vi.fn(), listArchivedChats: vi.fn(), recoverTask: vi.fn(), restoreChat: vi.fn(), deleteTask: vi.fn(), deleteChat: vi.fn() }));
vi.mock("../../context", () => ({ useProject: () => ({ selectedProject: project, refreshSelectedProject }) }));
vi.mock("../ui/DialogShell", () => ({ DialogShell: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => isOpen ? <div>{children}</div> : null }));
vi.mock("../Dialogs", () => ({ ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>Confirm deletion</button> }));

const now = new Date().toISOString();
const task = { id: "old-task", name: "Old task", updated_at: now };
const session = (id: string, title: string) => ({ id, title, agent: "claude", created_at: now, history_path: "", launch_mode: "acp" });

describe("Archived dialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onSessionRestored = vi.fn();
  const rows = () => [...container.querySelectorAll(".orbit-archived-row")].map((row) => row.textContent);
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label))!;
  const render = (scope: "tasks" | "sessions") => act(async () => root.render(<ArchivedDialog isOpen initialScope={scope} onClose={vi.fn()} onSessionRestored={onSessionRestored} />));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(listTasks).mockResolvedValue([task] as never);
    vi.mocked(listArchivedChats).mockImplementation(async (_project, owner) => owner === "_local" ? [session("local-chat", "Local chat")] : [session("task-chat", "Task chat")]);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

  it("opens on the scope of the heading it came from and lists both kinds under All", async () => {
    await render("sessions");
    expect(listArchivedChats).toHaveBeenCalledWith("p1", "_local");
    expect(listArchivedChats).toHaveBeenCalledWith("p1", "task-a");
    expect(rows().some((row) => row?.includes("Old task"))).toBe(false);
    expect(rows().find((row) => row?.includes("Task chat"))).toContain("Task A");
    act(() => button("All").click());
    expect(rows()).toHaveLength(3);
  });

  it("recovers a task, restores a session, and deletes after confirmation", async () => {
    await render("tasks");
    await act(async () => button("Recover task").click());
    expect(recoverTask).toHaveBeenCalledWith("p1", "old-task");
    expect(refreshSelectedProject).toHaveBeenCalled();

    act(() => button("Sessions").click());
    act(() => button("Task chat").click());
    await act(async () => button("Restore session").click());
    expect(restoreChat).toHaveBeenCalledWith("p1", "task-a", "task-chat");
    expect(onSessionRestored).toHaveBeenCalledWith("task-a");

    act(() => button("Delete").click());
    await act(async () => button("Confirm deletion").click());
    expect(deleteChat).toHaveBeenCalledWith("p1", "_local", "local-chat", "grove");
    expect(container.textContent).toContain("No archived sessions.");
  });

  it("filters by title or owning task", async () => {
    await render("sessions");
    const search = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "task a");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("Task chat");
  });
});
