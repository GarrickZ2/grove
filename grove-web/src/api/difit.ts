/**
 * Difit (Code Review Server) API client
 */

const API_BASE = "/api/v1";

export interface DifitStatusResponse {
  /** Status: "starting" | "running" | "completed" | "no_diff" | "not_available" */
  status: "starting" | "running" | "completed" | "no_diff" | "not_available";
  /** Difit server URL (e.g., "http://localhost:4968") */
  url: string | null;
  /** Difit process PID */
  pid: number | null;
}

export interface StopDifitResponse {
  stopped: boolean;
}

/**
 * Start difit code review server for a task
 * If already running, returns the existing session status
 */
export async function startDifit(
  projectId: string,
  taskId: string
): Promise<DifitStatusResponse> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/tasks/${taskId}/difit`,
    {
      method: "POST",
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to start difit: ${res.status}`);
  }
  return res.json();
}

/**
 * Get current difit status for a task
 */
export async function getDifitStatus(
  projectId: string,
  taskId: string
): Promise<DifitStatusResponse> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/tasks/${taskId}/difit`
  );
  if (!res.ok) {
    throw new Error(`Failed to get difit status: ${res.status}`);
  }
  return res.json();
}

/**
 * Stop difit code review server for a task
 */
export async function stopDifit(
  projectId: string,
  taskId: string
): Promise<StopDifitResponse> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/tasks/${taskId}/difit`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to stop difit: ${res.status}`);
  }
  return res.json();
}
