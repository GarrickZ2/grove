// Sketches API client
// Backend routes are mounted under /api/v1/projects/{id}/tasks/{taskId}/sketches

import { apiClient, getApiHost } from './client';

export interface SketchMeta {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SketchListResponse {
  sketches: SketchMeta[];
}

export async function listSketches(
  projectId: string,
  taskId: string,
): Promise<SketchMeta[]> {
  const data = await apiClient.get<SketchListResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches`,
  );
  return data.sketches;
}

export async function createSketch(
  projectId: string,
  taskId: string,
  name: string,
): Promise<SketchMeta> {
  return apiClient.post<{ name: string }, SketchMeta>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches`,
    { name },
  );
}

export async function deleteSketch(
  projectId: string,
  taskId: string,
  sketchId: string,
): Promise<void> {
  await apiClient.delete(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches/${sketchId}`,
  );
}

export async function renameSketch(
  projectId: string,
  taskId: string,
  sketchId: string,
  name: string,
): Promise<void> {
  await apiClient.post<{ name: string }, unknown>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches/${sketchId}/rename`,
    { name },
  );
}

export async function getSketchScene(
  projectId: string,
  taskId: string,
  sketchId: string,
): Promise<unknown> {
  return apiClient.get<unknown>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches/${sketchId}`,
  );
}

export async function putSketchScene(
  projectId: string,
  taskId: string,
  sketchId: string,
  scene: unknown,
): Promise<void> {
  await apiClient.put<{ scene: unknown }, unknown>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches/${sketchId}`,
    { scene },
  );
}

/**
 * Build a WebSocket URL for the sketches live-update endpoint.
 * The caller is responsible for appending HMAC auth (see `appendHmacToUrl`).
 */
export function sketchWsUrl(projectId: string, taskId: string): string {
  const host = getApiHost();
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${host}/api/v1/projects/${projectId}/tasks/${taskId}/sketches/ws`;
}
