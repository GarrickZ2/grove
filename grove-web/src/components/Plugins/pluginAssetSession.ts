import { apiClient, AUTH_CHANGED_EVENT } from "../../api/client";

// Share concurrent handshakes only. Resolved tokens must not survive a later
// plugin mount/reload, because Grove's asset key rotates on server restart.
const sessions = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();
let generation = 0;

window.addEventListener(AUTH_CHANGED_EVENT, () => {
  generation++;
  sessions.clear();
  listeners.forEach((listener) => listener());
});

export const getPluginAssetSessionGeneration = () => generation;

export function subscribeToPluginAssetSessionChanges(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function ensurePluginAssetSession(pluginId: string): Promise<string> {
  const existing = sessions.get(pluginId);
  if (existing) return existing;

  const pending = apiClient
    .post<undefined, { token: string }>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/asset-session`,
    )
    .then(({ token }) => token)
    .finally(() => {
      // An old request must not evict a newer authorization's handshake.
      if (sessions.get(pluginId) === pending) sessions.delete(pluginId);
    });
  sessions.set(pluginId, pending);
  return pending;
}
