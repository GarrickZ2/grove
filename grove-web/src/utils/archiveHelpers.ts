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
