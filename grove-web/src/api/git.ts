// Git API client

import { apiClient } from './client';

// ============================================================================
// Types
// ============================================================================

export interface RepoStatusResponse {
  current_branch: string;
  ahead: number;
  behind: number;
  uncommitted: number;
  stash_count: number;
  has_conflicts: boolean;
  has_origin: boolean;
}

export interface BranchDetailInfo {
  name: string;
  is_local: boolean;
  is_current: boolean;
  last_commit: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface BranchesDetailResponse {
  branches: BranchDetailInfo[];
  current: string;
}

export interface RepoCommitEntry {
  hash: string;
  message: string;
  author: string;
  time_ago: string;
}

export interface RepoCommitsResponse {
  commits: RepoCommitEntry[];
}

export interface GitOpResponse {
  success: boolean;
  message: string;
}

export interface CheckoutRequest {
  branch: string;
}

export interface StashRequest {
  pop?: boolean;
}

export interface CreateBranchRequest {
  name: string;
  base?: string;
  checkout?: boolean;
}

export interface RenameBranchRequest {
  new_name: string;
}

export interface CommitRequest {
  message: string;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get repository git status
 */
export async function getGitStatus(projectId: string): Promise<RepoStatusResponse> {
  return apiClient.get<RepoStatusResponse>(`/api/v1/projects/${projectId}/git/status`);
}

/**
 * Get all branches with details
 * @param projectId - Project ID
 * @param remote - Optional remote name ("local", "origin", "upstream", etc.). Defaults to "local".
 */
export async function getGitBranches(projectId: string, remote: string = 'local'): Promise<BranchesDetailResponse> {
  return apiClient.get<BranchesDetailResponse>(`/api/v1/projects/${projectId}/git/branches?remote=${encodeURIComponent(remote)}`);
}

/**
 * Get recent commits for the repository
 */
export async function getGitCommits(projectId: string): Promise<RepoCommitsResponse> {
  return apiClient.get<RepoCommitsResponse>(`/api/v1/projects/${projectId}/git/commits`);
}

/**
 * Checkout a branch
 */
export async function gitCheckout(projectId: string, branch: string): Promise<GitOpResponse> {
  return apiClient.post<CheckoutRequest, GitOpResponse>(
    `/api/v1/projects/${projectId}/git/checkout`,
    { branch }
  );
}

/**
 * Pull from remote
 */
export async function gitPull(projectId: string): Promise<GitOpResponse> {
  return apiClient.post<undefined, GitOpResponse>(
    `/api/v1/projects/${projectId}/git/pull`
  );
}

/**
 * Push to remote
 */
export async function gitPush(projectId: string): Promise<GitOpResponse> {
  return apiClient.post<undefined, GitOpResponse>(
    `/api/v1/projects/${projectId}/git/push`
  );
}

/**
 * Fetch from remote
 */
export async function gitFetch(projectId: string): Promise<GitOpResponse> {
  return apiClient.post<undefined, GitOpResponse>(
    `/api/v1/projects/${projectId}/git/fetch`
  );
}

/**
 * Create a new branch
 */
export async function createBranch(
  projectId: string,
  name: string,
  base?: string,
  checkout: boolean = false
): Promise<GitOpResponse> {
  return apiClient.post<CreateBranchRequest, GitOpResponse>(
    `/api/v1/projects/${projectId}/git/branches`,
    { name, base, checkout }
  );
}

/**
 * Delete a branch
 */
export async function deleteBranch(projectId: string, branchName: string): Promise<GitOpResponse> {
  return apiClient.delete<GitOpResponse>(`/api/v1/projects/${projectId}/git/branches/${encodeURIComponent(branchName)}`);
}

/**
 * Rename a branch
 */
export async function renameBranch(
  projectId: string,
  oldName: string,
  newName: string
): Promise<GitOpResponse> {
  return apiClient.post<RenameBranchRequest, GitOpResponse>(
    `/api/v1/projects/${projectId}/git/branches/${encodeURIComponent(oldName)}/rename`,
    { new_name: newName }
  );
}

/**
 * Commit changes
 */
export async function gitCommit(projectId: string, message: string): Promise<GitOpResponse> {
  return apiClient.post<CommitRequest, GitOpResponse>(
    `/api/v1/projects/${projectId}/git/commit`,
    { message }
  );
}
