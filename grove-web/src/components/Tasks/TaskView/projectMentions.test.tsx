// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ProjectListItem } from "../../../api/projects";
import type { TaskResponse } from "../../../api/tasks";
import { nextMentionIndex } from "../../../utils/fileMention";
import { projectMentionItems, mentionStatus } from "./projectMentions";
import { createFileChip } from "./fileMentionChip";

const project = { id: "p", name: "Workspace", path: "/studio", project_type: "studio" } as ProjectListItem;
const task = { id: "建设", name: "智能化建设", path: "/studio/tasks/建设", is_local: false } as TaskResponse;

describe("project mention choices", () => {
  it("puts the selectable project before loading even before any content request finishes", () => {
    const items = projectMentionItems(project, undefined, "");
    expect(items.map(item => item.category)).toEqual(["Project Root", "Loading"]);
    expect(items[0].path).toBe(project.path);
    expect(items[0].disabled).not.toBe(true);
    expect(items[1].disabled).toBe(true);
    expect(nextMentionIndex(items, 0, 1)).toBe(0);
    expect(nextMentionIndex(items, 0, -1)).toBe(0);
  });

  it("searches Task names while keeping Project first, with Tasks before matching files", () => {
    const items = projectMentionItems(project, {
      tasks: [task, { ...task, id: "_local", name: "Local" }, { ...task, id: "local", is_local: true }],
      files: ["建设.md"], filesLoading: false, tasksLoading: false,
    }, "建设");
    expect(items.map(item => item.category)).toEqual(["Project Root", "Task", "Shared Asset"]);
    expect(items[1]).toMatchObject({ displayName: task.name, path: task.path, kind: "file", isDir: true });
  });

  it("skips status rows in both keyboard directions and handles status-only menus", () => {
    const items = projectMentionItems(project, { tasks: [task], filesLoading: true, tasksLoading: false }, "");
    expect(nextMentionIndex(items, 0, 1)).toBe(2);
    expect(nextMentionIndex(items, 2, -1)).toBe(0);
    expect(nextMentionIndex(items, 2, 1)).toBe(0);
    expect(nextMentionIndex([mentionStatus("loading", "Loading…")], 0, 1)).toBe(0);
  });

  it("creates a Task chip with its name, inline icon and actual task directory", () => {
    const chip = createFileChip(task.path, true, task.name, "Task");
    expect(chip.dataset.file).toBe(task.path);
    expect(chip.dataset.label).toBe(task.name);
    expect(chip.dataset.category).toBe("Task");
    expect(chip.contentEditable).toBe("false");
    expect(chip.textContent).toContain(task.name);
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.querySelector("img")).toBeNull();
    // Persisted composer HTML retains both its icon and reference metadata.
    const restored = document.createElement("div");
    restored.innerHTML = chip.outerHTML;
    expect(restored.querySelector("[data-file]")?.getAttribute("data-file")).toBe(task.path);
    expect(restored.querySelector("svg")).not.toBeNull();
  });
});
