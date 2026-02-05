// Tasks API client

import { apiClient } from './client';

// ============================================================================
// Types
// ============================================================================

export interface CommitResponse {
  hash: string;
  message: string;
  time_ago: string;
}

export interface TaskResponse {
  id: string;
  name: string;
  branch: string;
  target: string;
  status: string;
  additions: number;
  deletions: number;
  files_changed: number;
  commits: CommitResponse[];
  created_at: string;
  updated_at: string;
  path: string;
}

export interface TaskListResponse {
  tasks: TaskResponse[];
}

export interface CreateTaskRequest {
  name: string;
  target?: string;
  notes?: string;
}

export type TaskFilter = 'active' | 'archived';

export interface NotesResponse {
  content: string;
}

export interface UpdateNotesRequest {
  content: string;
}

export interface CommitRequest {
  message: string;
}

export interface GitOperationResponse {
  success: boolean;
  message: string;
}

export interface DiffFileEntry {
  path: string;
  status: string; // "A" | "M" | "D" | "R"
  additions: number;
  deletions: number;
}

export interface DiffResponse {
  files: DiffFileEntry[];
  total_additions: number;
  total_deletions: number;
}

export interface CommitEntry {
  hash: string;
  message: string;
  time_ago: string;
}

export interface CommitsResponse {
  commits: CommitEntry[];
  total: number;
}

export interface ReviewCommentEntry {
  id: number;
  location: string;
  content: string;
  status: string; // "open" | "resolved" | "not_resolved"
  reply: string | null;
}

export interface ReviewCommentsResponse {
  comments: ReviewCommentEntry[];
  open_count: number;
  resolved_count: number;
  not_resolved_count: number;
}

export interface ReplyCommentRequest {
  comment_id: number;
  status: string; // "resolved" | "not_resolved"
  message: string;
}

// Task stats types
export interface FileEditEntry {
  path: string;
  edit_count: number;
  last_edited: string; // ISO 8601
}

export interface ActivityEntry {
  hour: string;      // ISO 8601 hour (e.g., "2024-01-15T14:00:00Z")
  buckets: number[]; // 60 minute buckets (index 0 = minute 00, index 59 = minute 59)
  total: number;     // Total edits in this hour
}

export interface TaskStatsResponse {
  total_edits: number;
  files_touched: number;
  last_activity: string | null;
  file_edits: FileEditEntry[];
  hourly_activity: ActivityEntry[];
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * List tasks for a project
 */
export async function listTasks(
  projectId: string,
  filter: TaskFilter = 'active'
): Promise<TaskResponse[]> {
  const response = await apiClient.get<TaskListResponse>(
    `/api/v1/projects/${projectId}/tasks?filter=${filter}`
  );
  return response.tasks;
}

/**
 * Get a single task
 */
export async function getTask(projectId: string, taskId: string): Promise<TaskResponse> {
  return apiClient.get<TaskResponse>(`/api/v1/projects/${projectId}/tasks/${taskId}`);
}

/**
 * Create a new task
 */
export async function createTask(
  projectId: string,
  name: string,
  target?: string,
  notes?: string
): Promise<TaskResponse> {
  return apiClient.post<CreateTaskRequest, TaskResponse>(
    `/api/v1/projects/${projectId}/tasks`,
    { name, target, notes }
  );
}

/**
 * Archive a task
 */
export async function archiveTask(projectId: string, taskId: string): Promise<TaskResponse> {
  return apiClient.post<undefined, TaskResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/archive`
  );
}

/**
 * Recover an archived task
 */
export async function recoverTask(projectId: string, taskId: string): Promise<TaskResponse> {
  return apiClient.post<undefined, TaskResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/recover`
  );
}

/**
 * Delete a task
 */
export async function deleteTask(projectId: string, taskId: string): Promise<void> {
  return apiClient.delete(`/api/v1/projects/${projectId}/tasks/${taskId}`);
}

/**
 * Get notes for a task
 */
export async function getNotes(projectId: string, taskId: string): Promise<NotesResponse> {
  return apiClient.get<NotesResponse>(`/api/v1/projects/${projectId}/tasks/${taskId}/notes`);
}

/**
 * Update notes for a task
 */
export async function updateNotes(
  projectId: string,
  taskId: string,
  content: string
): Promise<NotesResponse> {
  return apiClient.put<UpdateNotesRequest, NotesResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/notes`,
    { content }
  );
}

/**
 * Sync task: fetch and rebase onto target
 */
export async function syncTask(projectId: string, taskId: string): Promise<GitOperationResponse> {
  return apiClient.post<undefined, GitOperationResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/sync`
  );
}

/**
 * Commit changes in task
 */
export async function commitTask(
  projectId: string,
  taskId: string,
  message: string
): Promise<GitOperationResponse> {
  return apiClient.post<CommitRequest, GitOperationResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/commit`,
    { message }
  );
}

export interface MergeRequest {
  method?: "squash" | "merge-commit";
}

/**
 * Merge task into target branch
 */
export async function mergeTask(
  projectId: string,
  taskId: string,
  method?: "squash" | "merge-commit"
): Promise<GitOperationResponse> {
  const body = method ? { method } : undefined;
  return apiClient.post<MergeRequest | undefined, GitOperationResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/merge`,
    body
  );
}

/**
 * Get diff (changed files) for a task
 */
export async function getDiff(projectId: string, taskId: string): Promise<DiffResponse> {
  return apiClient.get<DiffResponse>(`/api/v1/projects/${projectId}/tasks/${taskId}/diff`);
}

/**
 * Get commit history for a task
 */
export async function getCommits(projectId: string, taskId: string): Promise<CommitsResponse> {
  return apiClient.get<CommitsResponse>(`/api/v1/projects/${projectId}/tasks/${taskId}/commits`);
}

/**
 * Get review comments for a task
 */
export async function getReviewComments(
  projectId: string,
  taskId: string
): Promise<ReviewCommentsResponse> {
  return apiClient.get<ReviewCommentsResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/review`
  );
}

/**
 * Reply to a review comment
 */
export async function replyReviewComment(
  projectId: string,
  taskId: string,
  commentId: number,
  status: 'resolved' | 'not_resolved',
  message: string
): Promise<ReviewCommentsResponse> {
  return apiClient.post<ReplyCommentRequest, ReviewCommentsResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/review`,
    { comment_id: commentId, status, message }
  );
}

/**
 * Get task statistics (file edits, activity)
 */
export async function getTaskStats(
  projectId: string,
  taskId: string
): Promise<TaskStatsResponse> {
  return apiClient.get<TaskStatsResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/stats`
  );
}

/**
 * Reset task: remove worktree and branch, recreate from target
 */
export async function resetTask(
  projectId: string,
  taskId: string
): Promise<GitOperationResponse> {
  return apiClient.post<undefined, GitOperationResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/reset`
  );
}
