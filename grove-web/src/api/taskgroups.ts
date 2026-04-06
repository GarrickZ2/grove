import { apiClient } from "./client";
import type { TaskGroup } from "../data/types";

export async function listTaskGroups(): Promise<{ groups: TaskGroup[] }> {
  return apiClient.get("/api/v1/taskgroups");
}

export async function createTaskGroup(name: string, color?: string): Promise<TaskGroup> {
  return apiClient.post("/api/v1/taskgroups", { name, color });
}

export async function updateTaskGroup(
  id: string,
  data: { name?: string; color?: string | null }
): Promise<TaskGroup> {
  return apiClient.patch(`/api/v1/taskgroups/${id}`, data);
}

export async function deleteTaskGroup(id: string): Promise<void> {
  return apiClient.delete(`/api/v1/taskgroups/${id}`);
}

export async function upsertTaskSlot(
  groupId: string,
  slot: { position: number; project_id: string; task_id: string; target_chat_id?: string }
): Promise<TaskGroup> {
  return apiClient.post(`/api/v1/taskgroups/${groupId}/slots`, slot);
}

export async function removeTaskSlot(groupId: string, position: number): Promise<TaskGroup> {
  return apiClient.delete(`/api/v1/taskgroups/${groupId}/slots/${position}`);
}

export async function setSlots(
  groupId: string,
  slots: { position: number; project_id: string; task_id: string; target_chat_id?: string }[],
): Promise<TaskGroup> {
  return apiClient.put(`/api/v1/taskgroups/${groupId}/slots`, { slots });
}
