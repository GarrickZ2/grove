type Panel = "chat" | "sketch";

function key(panel: Panel, projectId: string, taskId: string): string {
  return `grove:last-tab:${panel}:${projectId}:${taskId}`;
}

export function readLastActiveTab(
  panel: Panel,
  projectId: string,
  taskId: string,
): string | null {
  try {
    return localStorage.getItem(key(panel, projectId, taskId));
  } catch {
    return null;
  }
}

export function writeLastActiveTab(
  panel: Panel,
  projectId: string,
  taskId: string,
  tabId: string,
): void {
  try {
    localStorage.setItem(key(panel, projectId, taskId), tabId);
  } catch {
    // ignore storage errors
  }
}
