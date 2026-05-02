import type { Task } from "../data/types";
import type { TaskResponse } from "../api";

/** Convert API TaskResponse to frontend Task type */
export function convertTaskResponse(task: TaskResponse): Task {
  return {
    id: task.id,
    name: task.name,
    branch: task.branch,
    target: task.target,
    status: task.status === "archived" ? "archived" : "active",
    createdAt: new Date(task.created_at),
    updatedAt: new Date(task.updated_at),
    multiplexer: task.multiplexer || "tmux",
    createdBy: task.created_by || "",
    isLocal: task.is_local || false,
  };
}
