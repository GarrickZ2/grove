// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProject, listProjects, listResources, type ProjectListItem } from "../../../api/projects";
import { getTaskFiles, listTasks, type TaskResponse } from "../../../api/tasks";
import { useProjectMentions } from "./useProjectMentions";
import { projectMentionItems } from "./projectMentions";

vi.mock("../../../api/projects", () => ({ getProject: vi.fn(), listProjects: vi.fn(), listResources: vi.fn() }));
vi.mock("../../../api/tasks", () => ({ getTaskFiles: vi.fn(), listTasks: vi.fn() }));

const project: ProjectListItem = {
  id: "studio", name: "Workspace", path: "/studio", project_type: "studio", added_at: "",
  task_count: 1, live_count: 0, is_git_repo: false, exists: true, archived: false,
};
const task = { id: "建设", name: "智能化建设", path: "/studio/tasks/建设", is_local: false } as TaskResponse;
const projectsResponse = (projects: ProjectListItem[]) => ({ projects, current_project_id: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("project mention refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: ReturnType<typeof useProjectMentions>;
  function Harness({ open, filter }: { open: boolean; filter: string }) {
    current = useProjectMentions(open, filter);
    return null;
  }
  const render = async (open: boolean, filter = "") => {
    await act(async () => { root.render(<Harness open={open} filter={filter} />); });
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
    vi.mocked(listProjects).mockResolvedValue(projectsResponse([project]));
    vi.mocked(listTasks).mockResolvedValue([task]);
    vi.mocked(listResources).mockResolvedValue({ files: [] });
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("shows cached projects on reopen, replaces them after refresh, and does not fetch per keystroke", async () => {
    await render(true);
    expect(current.projects).toEqual([project]);
    await render(true, "Work");
    expect(listProjects).toHaveBeenCalledTimes(1);
    await render(false);
    const refresh = deferred<Awaited<ReturnType<typeof listProjects>>>();
    vi.mocked(listProjects).mockReturnValueOnce(refresh.promise);
    await render(true);
    expect(current.projects).toEqual([project]);
    expect(current.projectsLoading).toBe(true);
    const added = { ...project, id: "new", name: "New project" };
    await act(async () => refresh.resolve(projectsResponse([project, added])));
    expect(current.projects).toEqual([project, added]);
    expect(current.projectsLoading).toBe(false);
    await render(true, "New");
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it("keeps cached projects when refresh fails", async () => {
    await render(true);
    await render(false);
    vi.mocked(listProjects).mockRejectedValueOnce(new Error("offline"));
    await render(true);
    expect(current.projects).toEqual([project]);
    expect(current.projectsError).toBe(true);
    expect(current.projectsLoading).toBe(false);
  });

  it("ignores an obsolete list response after reopening", async () => {
    const old = deferred<Awaited<ReturnType<typeof listProjects>>>();
    vi.mocked(listProjects).mockReturnValueOnce(old.promise);
    await render(true);
    await render(false);
    await render(true);
    await act(async () => old.resolve(projectsResponse([])));
    expect(current.projects).toEqual([project]);
  });

  it("makes the root and Studio tasks available while files are pending, and preserves them on failure", async () => {
    const files = deferred<Awaited<ReturnType<typeof listResources>>>();
    vi.mocked(listResources).mockReturnValueOnce(files.promise);
    await render(true, "Workspace/");
    expect(listTasks).toHaveBeenCalledWith("studio", "active");
    let items = projectMentionItems(project, current.contents.studio, "");
    expect(items.map(item => item.category)).toEqual(["Project Root", "Loading", "Task"]);
    expect(items[0].disabled).not.toBe(true);
    expect(items[1].disabled).toBe(true);
    expect(items[2].path).toBe(task.path);
    await render(true, "Workspace/建设");
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(listResources).toHaveBeenCalledTimes(1);
    await act(async () => files.reject(new Error("offline")));
    items = projectMentionItems(project, current.contents.studio, "");
    expect(items.map(item => item.category)).toEqual(["Project Root", "Error", "Task"]);
  });

  it("refreshes cached tasks on reentry and ignores a delayed result for a previous selection", async () => {
    await render(true, "Workspace/");
    expect(current.contents.studio.tasks).toEqual([task]);
    await render(true, "Workspace");
    const old = deferred<TaskResponse[]>();
    vi.mocked(listTasks).mockReturnValueOnce(old.promise);
    await render(true, "Workspace/");
    expect(current.contents.studio.tasks).toEqual([task]);
    await render(false);
    const next = { ...task, id: "new", name: "New task" };
    vi.mocked(listTasks).mockResolvedValueOnce([task, next]);
    await render(true, "Workspace/");
    await act(async () => old.resolve([]));
    expect(current.contents.studio.tasks).toEqual([task, next]);
  });

  it("waits for Coding file requests and excludes Local from Task choices", async () => {
    const repo = { ...project, id: "repo", project_type: "repo" };
    const local = { ...task, id: "_local", is_local: true };
    vi.mocked(listProjects).mockResolvedValue(projectsResponse([repo]));
    vi.mocked(listTasks).mockResolvedValue([local, task]);
    vi.mocked(getProject).mockResolvedValue({ ...repo, local_task: local, current_branch: "main", tasks: [task] });
    const files = deferred<Awaited<ReturnType<typeof getTaskFiles>>>();
    vi.mocked(getTaskFiles).mockReturnValueOnce(files.promise);
    await render(true, "Workspace/");
    expect(getTaskFiles).toHaveBeenCalledWith("repo", "_local");
    expect(current.contents.repo.filesLoading).toBe(true);
    await act(async () => files.resolve({ files: ["src/main.rs"] }));
    const items = projectMentionItems(repo, current.contents.repo, "");
    expect(items.map(item => item.category)).toEqual(["Project Root", "Task", "Project Folder", "Project File"]);
    expect(items.filter(item => item.category === "Task").map(item => item.path)).toEqual([task.path]);
    expect(current.contents.repo.filesLoading).toBe(false);
  });
});
