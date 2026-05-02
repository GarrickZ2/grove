import type { Project, Task } from "../data/types";

/**
 * The constant ID used by the backend for a project's Local Task.
 * Must match `LOCAL_TASK_ID` in `src/storage/tasks.rs`.
 */
export const LOCAL_TASK_ID = "_local";

/**
 * Synthesize a Local Task from a Project object, without waiting for the backend.
 *
 * Every project has exactly one Local Task. Its identity is fully determined by
 * the project metadata, so the UI can construct it synchronously on render.
 * If the backend has already returned `project.localTask` (with real session
 * state), callers should prefer that over the synthetic one.
 */
export function synthesizeLocalTask(project: Project): Task {
  return {
    id: LOCAL_TASK_ID,
    name: project.name,
    branch: project.currentBranch || "",
    target: project.currentBranch || "",
    status: "active",
    createdAt: project.addedAt,
    updatedAt: new Date(),
    multiplexer: "tmux",
    createdBy: "",
    isLocal: true,
  };
}

/**
 * Resolve the effective Local Task for a project: prefer backend-sourced
 * (`project.localTask`) which has real session status; fall back to
 * synthesizing one from project metadata so the UI never blocks on I/O.
 */
export function resolveLocalTask(project: Project): Task {
  return project.localTask ?? synthesizeLocalTask(project);
}
