// Statistics API client

import { apiClient } from './client';

// ============================================================================
// Types
// ============================================================================

export interface BriefDataPoint {
  brief_length: number;
  interventions: number;
  user_messages: number;
  tool_calls: number;
  plan_updates: number;
}

export interface HotFile {
  path: string;
  task_count: number;
}

export interface CommentFlowResponse {
  total: number;
  human_total: number;
  agent_total: number;
  human_resolved: number;
  human_open: number;
  human_outdated: number;
  agent_resolved: number;
  agent_open: number;
  agent_outdated: number;
  avg_ai_rounds_on_human_comments: number;
}

export interface AgentStatResponse {
  agent: string;
  display_name: string;
  chat_tasks: number;
  chat_total_tool_calls: number;
  chat_avg_tool_calls_per_task: number;
  review_comments: number;
  review_hit_rate: number;
  contribution_score: number;
}

export interface ProjectStatisticsResponse {
  time_saved_hours: number;
  parallel_multiplier: number;
  peak_concurrency: number;
  total_active_minutes: number;
  tasks_completed: number;
  tasks_created: number;
  tasks_in_progress: number;
  agent_autonomy_rate: number;
  code_additions: number;
  code_deletions: number;
  avg_files_per_task: number;
  total_files_changed: number;
  avg_brief_length: number;
  avg_interventions_per_task: number;
  brief_insight_data: BriefDataPoint[];
  total_tool_calls: number;
  avg_tool_calls_per_task: number;
  avg_plan_updates_per_task: number;
  hot_files: HotFile[];
  comment_flow: CommentFlowResponse;
  agent_leaderboard: AgentStatResponse[];
}

// ============================================================================
// API functions
// ============================================================================

/**
 * Fetch project statistics for the given date range.
 * @param projectId - Project ID (hash)
 * @param from - Start date "YYYY-MM-DD" (inclusive), defaults to 30 days ago
 * @param to   - End date "YYYY-MM-DD" (inclusive), defaults to today
 */
export async function getProjectStatistics(
  projectId: string,
  from?: string,
  to?: string,
): Promise<ProjectStatisticsResponse> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString() ? `?${params.toString()}` : '';
  return apiClient.get<ProjectStatisticsResponse>(
    `/api/v1/projects/${projectId}/statistics${query}`,
  );
}
