import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readNavigationState, readTaskPageLocation, restoredTaskNavigation,
  writeNavigationState, writeTaskPageLocation, type NavigationState,
} from "./navigationState";

const navigation: NavigationState = {
  page: "tasks", projectId: "project-b", tasksMode: "zen", hasExitedWelcome: true,
};

beforeEach(() => { sessionStorage.clear(); });

describe("tab navigation restoration", () => {
  it.each(["dashboard", "settings", "projects", "work", "tasks", "plugin:sample"])("restores the current %s page after re-reading tab storage", page => {
    writeNavigationState({ ...navigation, page });
    expect(readNavigationState()).toEqual({ ...navigation, page });
  });

  it.each([false, true])("preserves the task list/detail position (showDetail=%s)", showDetail => {
    writeTaskPageLocation("zen", { projectId: "project-b", taskId: "task-b", inWorkspace: false, showDetail, filter: "archived" });
    expect(restoredTaskNavigation(navigation)).toEqual({
      projectId: "project-b", taskId: "task-b", viewMode: undefined,
      taskFilter: "archived", showDetail, restore: true,
    });
  });

  it("restores a workspace and keeps task selections isolated by project", () => {
    writeTaskPageLocation("zen", { projectId: "project-a", taskId: "task-a", inWorkspace: false, showDetail: false, filter: "active" });
    writeTaskPageLocation("zen", { projectId: "project-b", taskId: "task-b", inWorkspace: true, showDetail: true, filter: "active" });
    expect(restoredTaskNavigation(navigation)?.viewMode).toBe("terminal");
    expect(restoredTaskNavigation(navigation)?.taskId).toBe("task-b");
    expect(readTaskPageLocation("zen", "project-a")?.taskId).toBe("task-a");
  });

  it("restores a Blitz local task with its own project, independently of the sidebar project", () => {
    writeTaskPageLocation("blitz", { projectId: "project-c", taskId: "_local", inWorkspace: true, showDetail: true, filter: "active" });
    expect(restoredTaskNavigation({ ...navigation, tasksMode: "blitz" })).toMatchObject({ projectId: "project-c", taskId: "_local", viewMode: "terminal" });
  });

  it("does not replay a task deep-link when refreshing a different page", () => {
    writeTaskPageLocation("zen", { projectId: "project-b", taskId: "task-b", inWorkspace: true, showDetail: true, filter: "active" });
    expect(restoredTaskNavigation({ ...navigation, page: "settings" })).toBeNull();
  });

  it("uses the startup defaults in a fresh tab and ignores invalid saved state", () => {
    expect(readNavigationState()).toBeNull();
    sessionStorage.setItem("grove:navigation", "broken-json");
    expect(readNavigationState()).toBeNull();
    sessionStorage.setItem("grove:navigation", JSON.stringify({ ...navigation, page: "connect" }));
    expect(readNavigationState()).toBeNull();
    sessionStorage.setItem("grove:task-location:zen:project-b", JSON.stringify({ projectId: "project-a", taskId: "task-a" }));
    expect(readTaskPageLocation("zen", "project-b")).toBeNull();
  });

  it("continues to work when storage is unavailable", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      expect(readNavigationState()).toBeNull();
      expect(() => writeNavigationState(navigation)).not.toThrow();
    } finally {
      get.mockRestore(); set.mockRestore();
    }
  });
});
