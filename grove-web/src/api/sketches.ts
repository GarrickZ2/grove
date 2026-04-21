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
 * Flush variant used from `beforeunload` / last-chance flush paths. Uses
 * `fetch(..., { keepalive: true })` so the request survives page unload.
 * Browser-capped at ~64 KB body; larger scenes silently fall back by
 * throwing — callers should handle that and drop to a best-effort regular
 * PUT (which may itself be aborted by the browser on unload).
 */
export async function putSketchSceneKeepalive(
  projectId: string,
  taskId: string,
  sketchId: string,
  scene: unknown,
): Promise<void> {
  await apiClient.putKeepalive<{ scene: unknown }>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches/${sketchId}`,
    { scene },
  );
}

/**
 * Upload a PNG thumbnail for a sketch. The server writes it unconditionally;
 * staleness is detected at MCP-read time by comparing file mtimes (thumb vs
 * scene), so a thumbnail rendered slightly before a new scene write is simply
 * ignored on read instead of being rejected on write.
 */
export async function uploadSketchThumbnail(
  projectId: string,
  taskId: string,
  sketchId: string,
  png: Blob,
): Promise<void> {
  const path = `/api/v1/projects/${projectId}/tasks/${taskId}/sketches/${sketchId}/thumbnail`;
  await apiClient.postBinary(path, png, 'image/png');
}

export interface SketchHistoryEntry {
  id: string;
  ts: string;
  element_count?: number | null;
  label?: string | null;
}

export interface SketchHistoryResponse {
  entries: SketchHistoryEntry[];
}

/**
 * List checkpoints available to restore for this sketch. Checkpoints live
 * per-sketch — the returned list is already scoped to `sketchId`.
 */
export async function listSketchHistory(
  projectId: string,
  taskId: string,
  sketchId: string,
): Promise<SketchHistoryEntry[]> {
  const data = await apiClient.get<SketchHistoryResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches/${sketchId}/history`,
  );
  return data.entries;
}

/**
 * Restore the given checkpoint onto this sketch, overwriting its current
 * scene. Server broadcasts a `sketch_updated` event (agent source) so
 * connected clients hard-reload the canvas.
 */
export async function restoreSketchCheckpoint(
  projectId: string,
  taskId: string,
  sketchId: string,
  checkpointId: string,
): Promise<void> {
  await apiClient.post<{ checkpoint_id: string }, unknown>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sketches/${sketchId}/restore`,
    { checkpoint_id: checkpointId },
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
