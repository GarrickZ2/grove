import { AlertTriangle } from "lucide-react";
import type { ApiError } from "../api/client";
import type { ArchiveConfirmData } from "../api/types";
import { ERROR_CODES } from "../api/types";

/**
 * Context for archive operation
 */
export type ArchiveContext = "normal" | "after-merge";

/**
 * Pending archive confirmation state
 */
export interface PendingArchiveConfirm {
  projectId: string;
  taskId: string;
  message: React.ReactNode;
  context: ArchiveContext;
}

/**
 * Handle archive API error and determine if confirmation is needed
 *
 * @param error - The error from archive API call
 * @param projectId - Project ID
 * @param taskId - Task ID
 * @param taskName - Task name (for fallback)
 * @param context - Archive context ("normal" or "after-merge")
 * @param buildMessage - Function to build confirmation message
 * @param setPending - Callback to set pending confirmation state
 * @param showError - Callback to show error message
 * @returns true if confirmation is needed and handled, false otherwise
 */
export function handleArchiveError(
  error: unknown,
  projectId: string,
  taskId: string,
  taskName: string,
  context: ArchiveContext,
  buildMessage: (data: ArchiveConfirmData, name: string) => React.ReactNode,
  setPending: (confirm: PendingArchiveConfirm) => void,
  showError: (message: string) => void
): boolean {
  const e = error as ApiError;
  const data = (e.data || {}) as ArchiveConfirmData;

  // Check if this is a confirmation required error
  if (e?.status === 409 && data.code === ERROR_CODES.ARCHIVE_CONFIRM_REQUIRED) {
    setPending({
      projectId,
      taskId,
      message: buildMessage(data, taskName),
      context,
    });
    return true; // Confirmation needed, error handled
  }

  // Regular error
  showError(e?.message || "Failed to archive task");
  return false;
}

/**
 * Build archive confirmation message with rich JSX formatting
 *
 * @param data - Archive confirmation data from API
 * @param fallbackTaskName - Fallback task name if not in data
 * @returns React JSX element with formatted confirmation message
 */
export function buildArchiveConfirmMessage(
  data: ArchiveConfirmData,
  fallbackTaskName: string
): React.ReactNode {
  const taskName = data.task_name || fallbackTaskName;
  const branch = data.branch || "";
  const target = data.target || "";

  const hasWarning =
    data.worktree_dirty ||
    data.branch_merged === false ||
    data.dirty_check_failed ||
    data.merge_check_failed;

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-3 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-[var(--color-text-muted)]">Task</span>
          <span className="text-[var(--color-text)] font-medium">{taskName}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--color-text-muted)]">Branch</span>
          <span className="text-[var(--color-text)] font-mono text-xs">{branch}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--color-text-muted)]">Target</span>
          <span className="text-[var(--color-text)] font-mono text-xs">{target}</span>
        </div>
      </div>

      {hasWarning && (
        <div className="bg-[var(--color-warning)]/10 text-[var(--color-warning)] rounded-lg p-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="space-y-1">
              {data.dirty_check_failed && <p>Unable to verify working tree status.</p>}
              {data.worktree_dirty && (
                <>
                  <p className="font-medium">Working tree contains uncommitted changes.</p>
                  <p>These changes will be permanently lost upon archiving.</p>
                </>
              )}
              {data.merge_check_failed && <p>Unable to verify merge status.</p>}
              {data.branch_merged === false && <p>Branch has not been merged into target.</p>}
            </div>
          </div>
        </div>
      )}

      <p className="text-sm text-[var(--color-text-muted)]">
        Confirm task archiving?
      </p>
    </div>
  );
}
