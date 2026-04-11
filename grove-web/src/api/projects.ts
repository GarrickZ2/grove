// Projects API client

import { apiClient } from './client';
import type { StudioFileEntry, StudioWorkDirEntry } from './studio-types';
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
  is_git_repo: boolean;
  /** Whether the filesystem path still exists. false = "missing" state. */
  exists: boolean;
  /** Project type: "repo" or "studio" */
  project_type: string;
}

interface ProjectListResponse {
  projects: ProjectListItem[];
  /** ID of the project matching the current working directory (if any) */
  current_project_id: string | null;
}

export interface ProjectResponse {
  id: string;
  name: string;
  path: string;
  current_branch: string;
  /** Worktree tasks only. Local Task is on `local_task`. */
  tasks: TaskResponse[];
  /** The single Local Task for this project (with real session status). */
  local_task: TaskResponse | null;
  added_at: string;
  is_git_repo: boolean;
  /** Whether the filesystem path still exists. false = "missing" state. */
  exists: boolean;
  /** Project type: "repo" or "studio" */
  project_type: string;
}

interface AddProjectRequest {
  path: string;
  name?: string;
}

interface NewProjectRequest {
  parent_dir: string;
  name: string;
  init_git: boolean;
  project_type?: string;
}

export interface ProjectStatsResponse {
  total_tasks: number;
  live_tasks: number;
  idle_tasks: number;
  merged_tasks: number;
  archived_tasks: number;
  weekly_activity: number[];
}

interface BranchInfo {
  name: string;
  is_current: boolean;
}

interface BranchesResponse {
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
 * Create a brand new project: mkdir + (optional) git init + register.
 * Name is used as both the directory name and the Grove project name.
 */
export async function createNewProject(
  parentDir: string,
  name: string,
  initGit: boolean,
  projectType?: string,
): Promise<ProjectResponse> {
  return apiClient.post<NewProjectRequest, ProjectResponse>('/api/v1/projects/new', {
    parent_dir: parentDir,
    name,
    init_git: initGit,
    project_type: projectType,
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
 * @param id - Project ID
 * @param remote - Remote name ("local", "origin", "upstream", etc.). Default: "local"
 */
export async function getBranches(id: string, remote: string = 'local'): Promise<BranchesResponse> {
  return apiClient.get<BranchesResponse>(`/api/v1/projects/${id}/branches?remote=${encodeURIComponent(remote)}`);
}

interface RemotesResponse {
  remotes: string[];
}

/**
 * Get all remotes for a project
 */
export async function getRemotes(id: string): Promise<RemotesResponse> {
  return apiClient.get<RemotesResponse>(`/api/v1/projects/${id}/git/remotes`);
}

interface OpenResponse {
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

/**
 * Initialize a git repository in a non-git project directory.
 * Runs `git init` + an empty initial commit so the repo is immediately usable.
 */
export async function initGitRepo(id: string): Promise<ProjectResponse> {
  return apiClient.post<undefined, ProjectResponse>(`/api/v1/projects/${id}/init-git`);
}

// ============================================================================
// Studio Resource API
// ============================================================================

export type ResourceFile = StudioFileEntry;
export type WorkDirectoryEntry = StudioWorkDirEntry;

export async function listResources(id: string): Promise<{ files: ResourceFile[] }> {
  return apiClient.get<{ files: ResourceFile[] }>(`/api/v1/projects/${id}/resource`);
}

export async function uploadResource(id: string, files: File[]): Promise<ResourceFile[]> {
  const formData = new FormData();
  for (const file of files) formData.append('file', file);
  return apiClient.postFormData<ResourceFile[]>(`/api/v1/projects/${id}/resource/upload`, formData);
}

export async function deleteResource(id: string, path: string): Promise<void> {
  return apiClient.delete(`/api/v1/projects/${id}/resource?path=${encodeURIComponent(path)}`);
}

export async function listResourceWorkdirs(id: string): Promise<{ entries: WorkDirectoryEntry[] }> {
  return apiClient.get<{ entries: WorkDirectoryEntry[] }>(`/api/v1/projects/${id}/resource/workdir`);
}

export async function addResourceWorkdir(id: string, path: string): Promise<WorkDirectoryEntry> {
  return apiClient.post<{ path: string }, WorkDirectoryEntry>(`/api/v1/projects/${id}/resource/workdir`, { path });
}

export async function deleteResourceWorkdir(id: string, name: string): Promise<void> {
  return apiClient.delete(`/api/v1/projects/${id}/resource/workdir?name=${encodeURIComponent(name)}`);
}

export async function openResourceWorkdir(id: string, name: string): Promise<void> {
  await apiClient.postNoContent(`/api/v1/projects/${id}/resource/workdir/open?name=${encodeURIComponent(name)}`);
}

export async function previewResource(id: string, path: string): Promise<string> {
  return apiClient.getText(`/api/v1/projects/${id}/resource/preview?path=${encodeURIComponent(path)}`);
}

export function resourceDownloadUrl(id: string, path: string): string {
  return `/api/v1/projects/${id}/resource/download?path=${encodeURIComponent(path)}`;
}

export async function getInstructions(id: string): Promise<{ content: string }> {
  return apiClient.get<{ content: string }>(`/api/v1/projects/${id}/instructions`);
}

export async function updateInstructions(id: string, content: string): Promise<{ content: string }> {
  return apiClient.put<{ content: string }, { content: string }>(`/api/v1/projects/${id}/instructions`, { content });
}

export async function getMemory(id: string): Promise<{ content: string }> {
  return apiClient.get<{ content: string }>(`/api/v1/projects/${id}/memory`);
}

export async function updateMemory(id: string, content: string): Promise<{ content: string }> {
  return apiClient.put<{ content: string }, { content: string }>(`/api/v1/projects/${id}/memory`, { content });
}
