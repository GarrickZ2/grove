/**
 * Shared type definitions and constants for Archive operations
 */

/**
 * Archive confirmation data returned from API when confirmation is required
 */
export interface ArchiveConfirmData {
  code?: string;
  task_name?: string;
  branch?: string;
  target?: string;
  worktree_dirty?: boolean;
  branch_merged?: boolean;
  dirty_check_failed?: boolean;
  merge_check_failed?: boolean;
}

/**
 * API error codes
 */
export const ERROR_CODES = {
  ARCHIVE_CONFIRM_REQUIRED: "ARCHIVE_CONFIRM_REQUIRED",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  ARCHIVE_FAILED: "ARCHIVE_FAILED",
  ARCHIVED_TASK_NOT_FOUND: "ARCHIVED_TASK_NOT_FOUND",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
