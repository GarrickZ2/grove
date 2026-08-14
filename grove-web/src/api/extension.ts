// Grove Chrome Companion extension API — proxies tab queries through the
// connected extension over the backend WebSocket bridge. Going through
// apiClient (not raw fetch) keeps mobile-mode HMAC signing intact.
import { apiClient, appendHmacToUrl } from './client';

/** A browser tab as reported by the Chrome companion extension. */
export interface ExtensionTab {
  /** Chrome's internal tab id. May be missing if the tab is being discarded. */
  id?: number;
  /** Page <title> or url fallback. */
  title: string;
  /** Full URL of the tab. */
  url: string;
  /** Favicon URL if Chrome resolved one. */
  favIconUrl?: string;
}

/**
 * List currently open browser tabs (via the connected Chrome companion).
 * Throws when the extension is offline / backend is unreachable; callers
 * decide how to render the failure (empty state vs explicit "Disconnected").
 */
export async function listExtensionTabs(): Promise<ExtensionTab[]> {
  return apiClient.get<ExtensionTab[]>('/api/v1/extension/tabs');
}

/**
 * Probe whether the Chrome companion extension is reachable. Hits a
 * lightweight backend endpoint that only checks the in-process EXTENSION_SESSION
 * — no WebSocket round-trip to the browser extension. Callers should fetch
 * once on mount (or before opening a related UI flow); polling is wasted work.
 */
export async function getExtensionStatus(): Promise<boolean> {
  try {
    const resp = await apiClient.get<{ connected: boolean }>('/api/v1/extension/status');
    return !!resp.connected;
  } catch {
    return false;
  }
}

/**
 * URL to the companion zip download endpoint, pre-signed for HMAC mobile
 * mode. Use as `<a href={url} download>` — backend sets Content-Disposition.
 */
export async function getCompanionDownloadUrl(): Promise<string> {
  return appendHmacToUrl('/api/v1/extension/download');
}

/**
 * Ask the backend to launch Chrome on `chrome://extensions/`. Best-effort —
 * resolves on success, rejects with the backend's user-facing message
 * when Chrome isn't on PATH (caller should show a "copy URL" fallback).
 */
export async function openChromeExtensions(): Promise<{ ok: boolean; url: string }> {
  return apiClient.post<undefined, { ok: boolean; url: string }>(
    '/api/v1/extension/open-chrome',
  );
}

/**
 * Unpack the embedded companion into the user-chosen directory. The path
 * must come from `browseInstallFolder` — backend rejects relative paths and
 * a small set of system locations. Idempotent: subsequent calls overwrite
 * the directory file by file.
 */
export async function installCompanion(
  path: string,
): Promise<{ ok: boolean; path: string; files: number }> {
  return apiClient.post<{ path: string }, { ok: boolean; path: string; files: number }>(
    '/api/v1/extension/install',
    { path },
  );
}

/**
 * Open the install directory in the OS file manager (Finder / Explorer /
 * xdg-open). Caller must supply the same path that was used for install.
 */
export async function revealCompanionPath(
  path: string,
): Promise<{ ok: boolean; path: string }> {
  return apiClient.post<{ path: string }, { ok: boolean; path: string }>(
    '/api/v1/extension/reveal-path',
    { path },
  );
}

/**
 * Pop a native OS folder picker so the user can choose where to install
 * the companion.
 *
 * Three outcomes, matching `/api/v1/browse-folder`:
 *   - `{ path: "/abs/path" }`            user picked a folder
 *   - `{ path: null, cancelled: true }`  user dismissed the dialog
 *   - `{ path: null, cancelled: false }` no native picker could be shown
 *
 * The last case means the server is headless or its DISPLAY is stale, so the
 * caller should open the in-app folder browser rather than treat it as a
 * cancel.
 */
export async function browseInstallFolder(): Promise<{
  path: string | null;
  cancelled?: boolean;
}> {
  return apiClient.get<{ path: string | null; cancelled?: boolean }>(
    '/api/v1/extension/browse-install-folder',
  );
}
