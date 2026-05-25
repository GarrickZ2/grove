// Automations API client.
//
// REST surface mirrors src/api/handlers/automations.rs. Field shape matches
// AutomationDto / AutomationRun on the Rust side. `task_template` /
// `session_template` are optional and only populated when the corresponding
// _mode is "new".

import { apiClient } from './client';

export type TargetMode = 'new' | 'existing';

export interface TaskTemplate {
  name: string;
  target?: string;
  notes?: string;
}

export interface SessionTemplate {
  agent: string;
  title?: string;
}

export interface Automation {
  id: string;
  project: string;
  name: string;
  enabled: boolean;
  task_mode: TargetMode;
  task_id?: string;
  task_template?: TaskTemplate;
  session_mode: TargetMode;
  chat_id?: string;
  session_template?: SessionTemplate;
  prompt: string;
  schedule_cron: string;
  last_run_at?: number;
  last_run_status?: string;
  last_run_error?: string;
  next_run_at?: number;
  created_at: number;
  updated_at: number;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  trigger_kind: string;            // 'cron' | 'manual'
  prompt_snapshot: string;
  agent_snapshot?: string;
  resolved_task_id?: string;
  resolved_chat_id?: string;
  // Three-stage timeline
  triggered_at: number;
  queued_at?: number;
  completed_at?: number;
  // Result
  status: string;                  // 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'interrupted' | 'cancelled'
  phase?: string;                  // 'resolve_task' | 'resolve_session' | 'spawn_acp' | 'queue' | 'agent_run'
  error?: string;
  agent_response?: string;         // last_assistant_text truncated to 16KB; absent when agent ran tools only
}

export interface AutomationUpsert {
  name: string;
  enabled: boolean;
  task_mode: TargetMode;
  task_id?: string;
  task_template?: TaskTemplate;
  session_mode: TargetMode;
  chat_id?: string;
  session_template?: SessionTemplate;
  prompt: string;
  schedule_cron: string;
}

export interface TriggerResult {
  run_id: string;
  status: string; // 'queued' (running async — poll /runs) | 'failed' (pre-queue)
  error?: string;
  resolved_task_id?: string;
  resolved_chat_id?: string;
}

interface ListResponse { automations: Automation[]; }
interface RunsResponse { runs: AutomationRun[]; }

export async function listAutomations(projectId: string): Promise<Automation[]> {
  const data = await apiClient.get<ListResponse>(`/api/v1/projects/${projectId}/automations`);
  return data.automations;
}

export async function createAutomation(projectId: string, input: AutomationUpsert): Promise<Automation> {
  return apiClient.post<AutomationUpsert, Automation>(
    `/api/v1/projects/${projectId}/automations`,
    input,
  );
}

export async function updateAutomation(projectId: string, id: string, input: AutomationUpsert): Promise<Automation> {
  return apiClient.put<AutomationUpsert, Automation>(
    `/api/v1/projects/${projectId}/automations/${id}`,
    input,
  );
}

export async function deleteAutomation(projectId: string, id: string): Promise<void> {
  await apiClient.delete<void>(`/api/v1/projects/${projectId}/automations/${id}`);
}

export async function triggerAutomation(projectId: string, id: string): Promise<TriggerResult> {
  return apiClient.post<undefined, TriggerResult>(
    `/api/v1/projects/${projectId}/automations/${id}/trigger`,
  );
}

export async function listAutomationRuns(projectId: string, id: string): Promise<AutomationRun[]> {
  const data = await apiClient.get<RunsResponse>(
    `/api/v1/projects/${projectId}/automations/${id}/runs`,
  );
  return data.runs;
}

export interface CancelRunResult {
  status: string;       // 'cancelled' | 'noop'
  message?: string;
}

/// Cancel an in-flight or queued automation run. Backend decides whether to
/// dequeue (status=queued) or send ACP Cancel (status=running) based on
/// where in the pipeline the run currently sits.
export async function cancelAutomationRun(
  projectId: string,
  automationId: string,
  runId: string,
): Promise<CancelRunResult> {
  return apiClient.post<undefined, CancelRunResult>(
    `/api/v1/projects/${projectId}/automations/${automationId}/runs/${runId}/cancel`,
  );
}
