// Projects API client

import { apiClient } from './client';
import type { TaskResponse } from './tasks';

// ============================================================================
// Types
// ============================================================================

export interface ProjectListItem {
  id: string;
  name: string;
  path: string;
  added_at: string;
  task_count: number;
  live_count: number;
}

export interface ProjectListResponse {
  projects: ProjectListItem[];
  /** ID of the project matching the current working directory (if any) */
  current_project_id: string | null;
}

export interface ProjectResponse {
  id: string;
  name: string;
  path: string;
  current_branch: string;
  tasks: TaskResponse[];
  added_at: string;
}

export interface AddProjectRequest {
  path: string;
  name?: string;
}

export interface ProjectStatsResponse {
  total_tasks: number;
  live_tasks: number;
  idle_tasks: number;
  merged_tasks: number;
  archived_tasks: number;
  weekly_activity: number[];
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
}

export interface BranchesResponse {
  branches: BranchInfo[];
  current: string;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * List all registered projects
 */
export async function listProjects(): Promise<ProjectListResponse> {
  return apiClient.get<ProjectListResponse>('/api/v1/projects');
}

/**
 * Get a single project with its tasks
 */
export async function getProject(id: string): Promise<ProjectResponse> {
  return apiClient.get<ProjectResponse>(`/api/v1/projects/${id}`);
}

/**
 * Add a new project
 */
export async function addProject(path: string, name?: string): Promise<ProjectResponse> {
  return apiClient.post<AddProjectRequest, ProjectResponse>('/api/v1/projects', {
    path,
    name,
  });
}

/**
 * Delete a project
 */
export async function deleteProject(id: string): Promise<void> {
  return apiClient.delete(`/api/v1/projects/${id}`);
}

/**
 * Get project statistics
 */
export async function getProjectStats(id: string): Promise<ProjectStatsResponse> {
  return apiClient.get<ProjectStatsResponse>(`/api/v1/projects/${id}/stats`);
}

/**
 * Get branches for a project
 */
export async function getBranches(id: string): Promise<BranchesResponse> {
  return apiClient.get<BranchesResponse>(`/api/v1/projects/${id}/branches`);
}

export interface OpenResponse {
  success: boolean;
  message: string;
}

/**
 * Open project in IDE
 */
export async function openIDE(id: string): Promise<OpenResponse> {
  return apiClient.post<undefined, OpenResponse>(`/api/v1/projects/${id}/open-ide`);
}

/**
 * Open project in terminal
 */
export async function openTerminal(id: string): Promise<OpenResponse> {
  return apiClient.post<undefined, OpenResponse>(`/api/v1/projects/${id}/open-terminal`);
}
