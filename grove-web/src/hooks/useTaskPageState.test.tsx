import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskPageState } from "./useTaskPageState";
import type { Task } from "../data/types";

const task: Task = {
  id: "task-a", name: "Task A", branch: "task-a", target: "master",
  status: "active", createdAt: new Date(), updatedAt: new Date(), multiplexer: "tmux",
};

describe("task navigation by viewport", () => {
  let container: HTMLDivElement;
  let root: Root;

  function Page({ mobile, archived = false, orbit = false }: { mobile: boolean; archived?: boolean; orbit?: boolean }) {
    const [state, handlers] = useTaskPageState(mobile, orbit);
    const view = state.inWorkspace ? "workspace" : state.selectedTask && !mobile ? "overview" : "list";
    return (
      <div>
        <output>{view}</output>
        <button data-select onClick={() => handlers.handleSelectTask(archived ? { ...task, status: "archived" } : task)}>Task A</button>
        <button data-open onClick={() => handlers.handleDoubleClickTask(task)}>Open Workspace</button>
        <button data-back onClick={handlers.handleCloseTask}>Back</button>
        <button data-restore-overview onClick={() => { handlers.setSelectedTask(task); handlers.setInWorkspace(false); }}>Restore saved overview</button>
      </div>
    );
  }

  function click(selector: string) {
    act(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens Workspace immediately on a single mobile click", () => {
    act(() => root.render(<Page mobile />));
    click("[data-select]");
    expect(container.querySelector("output")!.textContent).toBe("workspace");
  });

  it("returns straight to the mobile list", () => {
    act(() => root.render(<Page mobile />));
    click("[data-select]");
    click("[data-back]");
    expect(container.querySelector("output")!.textContent).toBe("list");
    click("[data-select]");
    expect(container.querySelector("output")!.textContent).toBe("workspace");
  });

  it("keeps Overview and double-click navigation on desktop", () => {
    act(() => root.render(<Page mobile={false} />));
    click("[data-select]");
    expect(container.querySelector("output")!.textContent).toBe("overview");
    click("[data-open]");
    expect(container.querySelector("output")!.textContent).toBe("workspace");
    click("[data-back]");
    expect(container.querySelector("output")!.textContent).toBe("overview");
  });

  it("applies mobile selection after a viewport change", () => {
    act(() => root.render(<Page mobile={false} />));
    act(() => root.render(<Page mobile />));
    click("[data-select]");
    expect(container.querySelector("output")!.textContent).toBe("workspace");
  });

  it("has no mobile Overview step for archived tasks either", () => {
    act(() => root.render(<Page mobile archived />));
    click("[data-select]");
    expect(container.querySelector("output")!.textContent).toBe("workspace");
  });

  it("opens an Orbit task directly in Workspace and cannot return to the list", () => {
    act(() => root.render(<Page mobile={false} orbit />));
    click("[data-select]");
    expect(container.querySelector("output")!.textContent).toBe("workspace");
    click("[data-back]");
    expect(container.querySelector("output")!.textContent).toBe("workspace");
  });

  it("restores an old Overview location as Workspace in Orbit", () => {
    act(() => root.render(<Page mobile={false} orbit />));
    click("[data-restore-overview]");
    expect(container.querySelector("output")!.textContent).toBe("workspace");
  });

  it("enters Workspace when switching a selected Workbench task to Orbit", () => {
    act(() => root.render(<Page mobile={false} />));
    click("[data-select]");
    expect(container.querySelector("output")!.textContent).toBe("overview");
    act(() => root.render(<Page mobile={false} orbit />));
    expect(container.querySelector("output")!.textContent).toBe("workspace");
  });
});
