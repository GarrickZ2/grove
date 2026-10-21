// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FileMentionDropdown } from "./FileMentionDropdown";
import { projectMentionItems } from "../Tasks/TaskView/projectMentions";
import type { ProjectListItem } from "../../api/projects";
import type { TaskResponse } from "../../api/tasks";

vi.mock("../../context", () => ({ useTheme: () => ({ theme: { accentPalette: ["#3370ff"], colors: { bg: "#ffffff" } } }) }));

it("keeps loading unselectable and selects a Task directly with its icon and directory", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const container = document.createElement("div");
  const root = createRoot(container);
  const select = vi.fn();
  const hover = vi.fn();
  const task = { id: "task", name: "智能化建设", path: "/studio/tasks/task", is_local: false } as TaskResponse;
  const items = projectMentionItems(
    { id: "studio", name: "Workspace", path: "/studio", project_type: "studio" } as ProjectListItem,
    { tasks: [task], filesLoading: true, tasksLoading: false }, "",
  );
  try {
    act(() => root.render(<FileMentionDropdown items={items} selectedIdx={0} visible onSelect={select} onMouseEnter={hover} />));
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(true);
    act(() => buttons[1].click());
    expect(select).not.toHaveBeenCalled();
    expect(buttons[2].querySelector("svg")).not.toBeNull();
    act(() => buttons[2].click());
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(task.path, true, task.name, "Task");
  } finally {
    act(() => root.unmount());
    if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  }
});
