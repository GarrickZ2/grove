import { getApiHost } from "../../../api/client";

/** The terminal socket on whichever server this window shows, paired machines included. */
export function terminalEndpoint(projectId?: string, taskId?: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = projectId && taskId
    ? `/api/v1/projects/${projectId}/tasks/${taskId}/terminal`
    : "/api/v1/terminal";
  return `${protocol}//${getApiHost()}${path}`;
}

/**
 * A task terminal's connection key. The server is part of it: a cached shell
 * belongs to the machine it was opened on.
 */
export function taskTerminalKey(projectId: string, taskId: string): string {
  return `task:${getApiHost()}:${projectId}:${taskId}`;
}
