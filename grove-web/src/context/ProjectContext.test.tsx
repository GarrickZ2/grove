import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProvider, useProject } from "./ProjectContext";
import { getProject, listProjects } from "../api";
import { writeNavigationState } from "../utils/navigationState";

vi.mock("../api", () => ({
  listProjects: vi.fn(), getProject: vi.fn(), addProject: vi.fn(),
  createNewProject: vi.fn(), cloneProject: vi.fn(), deleteProject: vi.fn(),
  renameProject: vi.fn(), archiveProject: vi.fn(), restoreProject: vi.fn(),
}));

function Status() {
  const { selectedProject, isLoading } = useProject();
  return <div>{isLoading ? "Loading" : selectedProject?.id ?? "none"}</div>;
}

describe("project selection on reload", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
      removeItem: (key: string) => { saved.delete(key); },
      clear: () => saved.clear(),
    });
    sessionStorage.clear(); localStorage.clear();
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(listProjects).mockResolvedValue({
      current_project_id: "project-a",
      projects: ["project-a", "project-b"].map(id => ({
        id, name: id, path: `/${id}`, task_count: 0, live_count: 0, added_at: "2026-10-12T00:00:00Z", exists: true, is_git_repo: true, project_type: "repo", archived: false,
      })),
    });
    vi.mocked(getProject).mockImplementation(async id => ({
      id, name: id, path: `/${id}`, current_branch: "master", tasks: [],
      local_task: null, added_at: "2026-10-12T00:00:00Z", exists: true, is_git_repo: true, project_type: "repo", archived: false,
    }));
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    vi.resetAllMocks(); vi.unstubAllGlobals();
  });

  it("reloads the current tab's project instead of the server's startup project", async () => {
    writeNavigationState({ page: "tasks", projectId: "project-b", tasksMode: "zen", hasExitedWelcome: true });
    await act(async () => root.render(<ProjectProvider><Status /></ProjectProvider>));
    expect(container.textContent).toBe("project-b");
    expect(getProject).toHaveBeenCalledWith("project-b");
    expect(getProject).not.toHaveBeenCalledWith("project-a");
    act(() => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<ProjectProvider><Status /></ProjectProvider>));
    expect(container.textContent).toBe("project-b");
  });

  it("retains the original startup-project priority in a fresh tab", async () => {
    localStorage.setItem("grove-selected-project", "project-b");
    await act(async () => root.render(<ProjectProvider><Status /></ProjectProvider>));
    expect(container.textContent).toBe("project-a");
  });

  it("falls back to the startup project when the saved project no longer exists", async () => {
    writeNavigationState({ page: "tasks", projectId: "deleted", tasksMode: "zen", hasExitedWelcome: true });
    await act(async () => root.render(<ProjectProvider><Status /></ProjectProvider>));
    expect(container.textContent).toBe("project-a");
    expect(getProject).not.toHaveBeenCalledWith("deleted");
  });

  it("keeps the loading state until the restored project's details are ready", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getProject>>) => void;
    const details = new Promise<Awaited<ReturnType<typeof getProject>>>(done => { resolve = done; });
    vi.mocked(getProject).mockReturnValue(details);
    await act(async () => root.render(<ProjectProvider><Status /></ProjectProvider>));
    expect(container.textContent).toBe("Loading");
    await act(async () => resolve({
      id: "project-a", name: "A", path: "/a", current_branch: "master", tasks: [], local_task: null,
      added_at: "2026-10-12T00:00:00Z", exists: true, is_git_repo: true, project_type: "repo", archived: false,
    }));
    expect(container.textContent).toBe("project-a");
  });
});
