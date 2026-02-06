// Hooks (notification) API client

import { apiClient } from './client';

// ============================================================================
// Types
// ============================================================================

export interface HookEntryResponse {
  task_id: string;
  task_name: string;
  level: string;
  timestamp: string;
  message: string | null;
  project_id: string;
  project_name: string;
}

export interface HooksListResponse {
  hooks: HookEntryResponse[];
  total: number;
}

// ============================================================================
// API Functions
// ============================================================================

export async function listAllHooks(): Promise<HooksListResponse> {
  return apiClient.get<HooksListResponse>('/api/v1/hooks');
}

export async function dismissHook(projectId: string, taskId: string): Promise<void> {
  await apiClient.delete(`/api/v1/projects/${projectId}/hooks/${taskId}`);
}
