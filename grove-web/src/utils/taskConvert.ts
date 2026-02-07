import type { Task, TaskStatus } from "../data/types";
import type { TaskResponse } from "../api";

/** Convert API TaskResponse to frontend Task type */
export function convertTaskResponse(task: TaskResponse): Task {
  return {
    id: task.id,
    name: task.name,
    branch: task.branch,
    target: task.target,
    status: task.status as TaskStatus,
    additions: task.additions,
    deletions: task.deletions,
    filesChanged: task.files_changed,
    commits: task.commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: "author",
      date: new Date(),
    })),
    createdAt: new Date(task.created_at),
    updatedAt: new Date(task.updated_at),
  };
}
