// Review API client — Full diff data for diff review UI

import { apiClient } from './client';
import type { ReviewCommentsResponse } from './tasks';

// ============================================================================
// Types
// ============================================================================

export interface DiffLine {
  line_type: 'context' | 'insert' | 'delete';
  old_line: number | null;
  new_line: number | null;
  content: string;
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  old_path: string;
  new_path: string;
  change_type: 'added' | 'modified' | 'deleted' | 'renamed';
  hunks: DiffHunk[];
  is_binary: boolean;
  additions: number;
  deletions: number;
}

export interface FullDiffResult {
  files: DiffFile[];
  total_additions: number;
  total_deletions: number;
}

// ============================================================================
// API Functions
// ============================================================================

/** Get full parsed diff with hunks and lines */
export async function getFullDiff(
  projectId: string,
  taskId: string,
  fromRef?: string,
  toRef?: string,
): Promise<FullDiffResult> {
  let url = `/api/v1/projects/${projectId}/tasks/${taskId}/diff?full=true`;
  if (fromRef) url += `&from_ref=${encodeURIComponent(fromRef)}`;
  if (toRef) url += `&to_ref=${encodeURIComponent(toRef)}`;
  return apiClient.get<FullDiffResult>(url);
}

/** Create a new review comment */
export async function createComment(
  projectId: string,
  taskId: string,
  anchor: { filePath: string; side: string; startLine: number; endLine: number },
  content: string,
): Promise<ReviewCommentsResponse> {
  return apiClient.post<Record<string, unknown>, ReviewCommentsResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/review/comments`,
    {
      file_path: anchor.filePath,
      side: anchor.side,
      start_line: anchor.startLine,
      end_line: anchor.endLine,
      content,
      author: 'You',
      location: `${anchor.filePath}:${anchor.startLine}`,
    },
  );
}

/** Reply to a review comment (no status change) */
export async function replyReviewComment(
  projectId: string,
  taskId: string,
  commentId: number,
  message: string,
): Promise<ReviewCommentsResponse> {
  return apiClient.post<Record<string, unknown>, ReviewCommentsResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/review`,
    { comment_id: commentId, message, author: 'You' },
  );
}

/** Update a review comment's status (open/resolved) */
export async function updateCommentStatus(
  projectId: string,
  taskId: string,
  commentId: number,
  status: 'open' | 'resolved',
): Promise<ReviewCommentsResponse> {
  return apiClient.put<Record<string, unknown>, ReviewCommentsResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/review/comments/${commentId}/status`,
    { status },
  );
}

/** Get file content from worktree (for expanding context lines) */
export async function getFileContent(
  projectId: string,
  taskId: string,
  filePath: string,
): Promise<string> {
  const resp = await apiClient.get<{ content: string; path: string }>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/file?path=${encodeURIComponent(filePath)}`,
  );
  return resp.content;
}

/** Delete a review comment */
export async function deleteComment(
  projectId: string,
  taskId: string,
  commentId: number,
): Promise<ReviewCommentsResponse> {
  return apiClient.delete<ReviewCommentsResponse>(
    `/api/v1/projects/${projectId}/tasks/${taskId}/review/comments/${commentId}`,
  );
}
