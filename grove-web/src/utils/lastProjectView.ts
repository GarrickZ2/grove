const KEY_PREFIX = "grove:last-view:";

function key(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

export function readLastProjectView(projectId: string): string | null {
  try {
    return localStorage.getItem(key(projectId));
  } catch {
    return null;
  }
}

export function writeLastProjectView(projectId: string, view: string): void {
  try {
    localStorage.setItem(key(projectId), view);
  } catch {
    // ignore storage errors (private browsing, quota exceeded)
  }
}
