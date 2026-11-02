import { describe, expect, it } from "vitest";
import type { TaskResponse } from "../../api";
import type { Project } from "../../data/types";
import { addedLabel, kindLabel, matchProjects, pathLabel, projectHealth, projectsInTab, projectsSummary, tabCounts, taskLine, taskRows, taskTally } from "./projectsView";

const project = (id: string, patch: Partial<Project> = {}): Project => ({
  id,
  name: id,
  path: `/Users/me/work/${id}`,
  currentBranch: "",
  tasks: [],
  localTask: null,
  addedAt: new Date("2026-10-03T12:00:00Z"),
  taskCount: 0,
  isGitRepo: true,
  exists: true,
  projectType: "repo",
  archived: false,
  ...patch,
});

const grove = project("grove", { taskCount: 3 });
const site = project("site", { projectType: "studio", isGitRepo: false, taskCount: 1, path: "/Users/me/.grove/studios/site" });
const gone = project("gone", { exists: false });
const old = project("old", { archived: true });
const active = [grove, site, gone];

describe("projectsView", () => {
  it("splits tabs by kind and keeps archived apart", () => {
    expect(projectsInTab("all", active, [old])).toEqual(active);
    expect(projectsInTab("coding", active, [old]).map((p) => p.id)).toEqual(["grove", "gone"]);
    expect(projectsInTab("studio", active, [old]).map((p) => p.id)).toEqual(["site"]);
    expect(projectsInTab("archived", active, [old])).toEqual([old]);
    expect(tabCounts(active, [old])).toEqual({ all: 3, coding: 2, studio: 1, archived: 1 });
  });

  it("searches names and paths, case-insensitively", () => {
    expect(matchProjects(active, "  ")).toEqual(active);
    expect(matchProjects(active, "GRO").map((p) => p.id)).toEqual(["grove", "site"]);
    expect(matchProjects(active, "studios").map((p) => p.id)).toEqual(["site"]);
    expect(matchProjects(active, "nope")).toEqual([]);
  });

  it("summarises the real counts", () => {
    expect(projectsSummary(active, [])).toBe("3 projects · 4 tasks across them · 1 missing");
    expect(projectsSummary([project("a")], [])).toBe("1 project · no tasks yet");
    expect(projectsSummary([], [old])).toBe("No active projects · 1 archived");
    expect(projectsSummary([], [])).toBe("Add a Git repo or start a Studio to begin.");
  });

  it("describes each tile", () => {
    expect(projectHealth(grove)).toBe("ok");
    expect(projectHealth(gone)).toBe("missing");
    expect(projectHealth(project("plain", { isGitRepo: false }))).toBe("not-git");
    expect(projectHealth(site)).toBe("ok");
    expect(taskLine(grove)).toBe("3 tasks");
    expect(taskLine(site)).toBe("1 task");
    expect(taskLine(project("none", { taskCount: undefined }))).toBe("No tasks");
    expect(kindLabel(site)).toBe("Studio");
    expect(kindLabel(grove)).toBe("Git repo");
    expect(kindLabel(project("plain", { isGitRepo: false }))).toBe("Folder");
    const now = new Date("2026-11-01T12:00:00Z").getTime();
    expect(addedLabel(grove, now)).toBe("Added Oct 3");
    expect(addedLabel(project("y", { addedAt: new Date("2025-01-05T12:00:00Z") }), now)).toBe("Added Jan 5, 2025");
    expect(addedLabel(project("bad", { addedAt: new Date("nope") }), now)).toBe("");
  });

  it("hides Studio paths", () => {
    expect(pathLabel(grove)).toBe("~/work/grove");
    expect(pathLabel(site)).toBeNull();
    expect(pathLabel(project("odd", { projectType: "studio", path: "studio://odd" }))).toBeNull();
  });

  it("orders tasks for the detail and tallies them", () => {
    const task = (id: string, status: string, updated: string, patch: Partial<TaskResponse> = {}): TaskResponse => ({
      id, name: id, branch: `b/${id}`, target: "main", status, additions: 0, deletions: 0, files_changed: 0, commits: [],
      created_at: updated, updated_at: updated, path: "", multiplexer: "tmux", enableTerminal: true, enableChat: true, created_by: "", is_local: false, ...patch,
    });
    const rows = taskRows({
      tasks: [
        task("old-idle", "idle", "2026-10-01T00:00:00Z"),
        task("merged", "merged", "2026-10-30T00:00:00Z"),
        task("new-idle", "idle", "2026-10-20T00:00:00Z"),
        task("gone", "archived", "2026-10-31T00:00:00Z"),
        task("live", "live", "2026-10-02T00:00:00Z"),
        task("clash", "conflict", "2026-10-03T00:00:00Z"),
        task("weird", "mystery", "bad-date"),
      ],
      local_task: task("_local", "live", "2026-10-31T00:00:00Z", { is_local: true }),
    });
    expect(rows.map((r) => r.id)).toEqual(["_local", "live", "clash", "new-idle", "old-idle", "weird", "merged"]);
    expect(rows[0].isLocal).toBe(true);
    expect(rows.find((r) => r.id === "weird")).toMatchObject({ label: "Idle", tone: "idle", updatedAt: 0 });
    expect(taskTally(rows)).toEqual({ live: 2, attention: 1, idle: 3, merged: 1 });
    expect(taskRows(null)).toEqual([]);
  });
});
