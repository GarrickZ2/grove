import { apiClient, type ApiError } from "./client";
import type { AgentConfigSelection } from "./automations";

export interface MemoryTag {
  key: string;
  value: string;
  icon?: string;
}

export interface MemoryEntity {
  project_id: string;
  entity_id: string;
  file_path: string;
  title: string;
  description: string;
  tags: MemoryTag[];
  base_score: number;
  access_count: number;
  score: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryEntityDocument extends MemoryEntity {
  body: string;
}

export interface MemoryEntityMetadata {
  entity_id: string;
  title: string;
  tags: MemoryTag[];
}

export interface MemoryLog {
  id: string;
  project_id: string;
  task_id: string;
  chat_id?: string;
  agent?: string;
  title: string;
  tags: string[];
  description: string;
  created_at: string;
}

export interface MemoryRelation {
  id: string;
  project_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  description: string;
  base_score: number;
  access_count: number;
  score: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryConfig {
  project_id: string;
  enabled: boolean;
  deep_organization: boolean;
  pending_log_threshold: number | null;
  organization: {
    id: string;
    enabled: boolean;
    agent_config: AgentConfigSelection;
    schedule_cron: string;
    event_triggers: string[];
    next_run_at?: number;
  };
}

export interface MemoryConfigInput {
  enabled: boolean;
  deep_organization: boolean;
  pending_log_threshold: number | null;
  organization_enabled: boolean;
  agent_config: AgentConfigSelection;
  schedule_cron: string;
  event_triggers: string[];
}

export interface MemoryOverview {
  entity_count: number;
  relation_count: number;
  log_count: number;
  run_count: number;
  successful_run_count: number;
  failed_run_count: number;
  in_progress_run_count: number;
  waiting_run_count: number;
  active_run_count: number;
  last_organized_at?: number;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_by_currency: Record<string, number>;
  };
}

export interface Page<T> {
  items: T[];
  next_cursor?: string;
}

function listPath(path: string, query?: string, cursor?: string, limit = 40) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query?.trim()) params.set("q", query.trim());
  if (cursor) params.set("cursor", cursor);
  return `${path}?${params.toString()}`;
}

export async function getMemoryConfig(projectId: string): Promise<MemoryConfig | null> {
  try {
    return await apiClient.get<MemoryConfig>(`/api/v1/projects/${projectId}/memory/config`);
  } catch (error) {
    if ((error as ApiError).status === 404) return null;
    throw error;
  }
}

export function updateMemoryConfig(projectId: string, input: MemoryConfigInput) {
  return apiClient.put<MemoryConfigInput, MemoryConfig>(
    `/api/v1/projects/${projectId}/memory/config`,
    input,
  );
}

export function getMemoryOverview(projectId: string) {
  return apiClient.get<MemoryOverview>(`/api/v1/projects/${projectId}/memory/overview`);
}

export function listMemoryEntities(projectId: string, query?: string, cursor?: string, limit = 40) {
  return apiClient.get<Page<MemoryEntity>>(
    listPath(`/api/v1/projects/${projectId}/memory/entities`, query, cursor, limit),
  );
}

export function getMemoryEntity(projectId: string, entityId: string) {
  return apiClient.get<MemoryEntityDocument>(
    `/api/v1/projects/${projectId}/memory/entities/${encodeURIComponent(entityId)}`,
  );
}

export function resolveMemoryEntities(projectId: string, entityIds: string[]) {
  return apiClient.post<{ entity_ids: string[] }, { items: MemoryEntityMetadata[] }>(
    `/api/v1/projects/${projectId}/memory/entities/resolve`,
    { entity_ids: entityIds },
  );
}

export function deleteMemoryEntity(projectId: string, entityId: string) {
  return apiClient.delete<void>(
    `/api/v1/projects/${projectId}/memory/entities/${encodeURIComponent(entityId)}`,
  );
}

export function listMemoryLogs(projectId: string, query?: string, cursor?: string) {
  return apiClient.get<Page<MemoryLog>>(
    listPath(`/api/v1/projects/${projectId}/memory/logs`, query, cursor),
  );
}

export function deleteMemoryLogs(projectId: string, ids: string[]) {
  return apiClient.post<{ ids: string[] }, { deleted: number }>(
    `/api/v1/projects/${projectId}/memory/logs/delete`,
    { ids },
  );
}

export function listMemoryRelations(projectId: string, entityId?: string, limit = 40, cursor?: string) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (entityId) params.set("entity_id", entityId);
  if (cursor) params.set("cursor", cursor);
  return apiClient.get<Page<MemoryRelation>>(
    `/api/v1/projects/${projectId}/memory/relations?${params.toString()}`,
  );
}

export function getMemoryRunHistory(projectId: string, runId: string) {
  return apiClient.get<{ events: Record<string, unknown>[]; usage: MemoryOverview["usage"] }>(
    `/api/v1/projects/${projectId}/memory/runs/${encodeURIComponent(runId)}/history`,
  );
}

export function deleteMemoryRun(projectId: string, runId: string) {
  return apiClient.delete<void>(
    `/api/v1/projects/${projectId}/memory/runs/${encodeURIComponent(runId)}`,
  );
}
