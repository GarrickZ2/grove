import { apiClient } from "../../api/client";

// One handshake per plugin per page load. Rejected handshakes are evicted so a
// transient network/auth failure can recover on the next render.
const sessions = new Map<string, Promise<string>>();

export function ensurePluginAssetSession(pluginId: string): Promise<string> {
  const existing = sessions.get(pluginId);
  if (existing) return existing;

  const pending = apiClient
    .post<undefined, { token: string }>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/asset-session`,
    )
    .then(({ token }) => token)
    .catch((error) => {
      sessions.delete(pluginId);
      throw error;
    });
  sessions.set(pluginId, pending);
  return pending;
}
