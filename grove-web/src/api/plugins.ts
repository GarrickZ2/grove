// Plugin development & management API: scaffold/develop, install (local copy /
// git clone), register dev folders, list, delete, and per-plugin file storage.
import { apiClient } from './client';

export const PLUGINS_CHANGED_EVENT = 'grove:plugins-changed';

export function notifyPluginsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED_EVENT));
  }
}

/**
 * Pop a native OS folder picker for choosing where to create/develop a plugin.
 * Resolves with `path: null` when the user cancels.
 */
export async function browsePluginFolder(): Promise<{ path: string | null }> {
  return apiClient.get<{ path: string | null }>('/api/v1/plugins/browse-folder');
}

export interface ScaffoldPluginResult {
  ok: boolean;
  /** Absolute path the starter was written into. */
  path: string;
  /** Plugin name (derived from the folder name). */
  name: string;
  /** Suggested next-step shell command (build the dist/ before opening). */
  next?: string;
}

/**
 * Write a minimal plugin starter (plugin.json + README.md) into `path`.
 * Backend refuses to overwrite an existing plugin.json.
 */
export async function scaffoldPlugin(
  path: string,
  name: string,
): Promise<ScaffoldPluginResult> {
  return apiClient.post<{ path: string; name: string }, ScaffoldPluginResult>(
    '/api/v1/plugins/scaffold',
    { path, name },
  );
}

/** A registered plugin. `source` decides where the files live + delete behavior. */
export interface Plugin {
  id: string;
  name: string;
  version: string;
  source: 'dev' | 'local' | 'git';
  /** dev: the user's own folder; local/git: ~/.grove/plugins/<id>. */
  local_path: string;
  git_url?: string;
  subpath?: string;
  created_at: string;
  updated_at: string;
  /** Present when the plugin contributes an MCP server. `available` is whether
   *  its `command` resolves on PATH. */
  runtime?: { command: string; available: boolean };
  /** Declared manifest permissions (e.g. `["storage"]`) — shown so the user
   *  knows what the plugin can access. */
  permissions?: string[];
  /** False when the plugin's folder no longer exists on disk (deleted without
   *  uninstalling) — the row can only be cleaned up (deleted) from the registry. */
  exists?: boolean;
  /** False when a declared panel/sidebar entry file (e.g. dist/index.html) is
   *  missing — i.e. an unbuilt dev plugin. Imported plugins are always built. */
  built?: boolean;
  /** Declared contribution points whose built entry is missing on disk
   *  (`"panel"`/`"sidebar"`/`"mcp"`/`"backend"`). Empty = all built. */
  unbuilt?: string[];
  /** Exact content comparison against the SDK bundled with this Grove build. */
  sdk_status?: 'current' | 'outdated' | 'missing';
  /** Top-level `icon`: a path to an image in the plugin (served via /asset), or
   *  an emoji. Null/absent → the UI shows a default puzzle icon. */
  icon?: string | null;
  /** Which contribution points the plugin declares — decides where it can open. */
  contributes?: {
    /** Workspace panel (task-scoped). `side` picks the IDE Layout column the
     *  panel mounts in ("left"=aux, "right"=info; default "left"). `shortcut`
     *  is an optional default keybinding (e.g. "Mod+Alt+p") registered into the
     *  keymap so the user can press it / reconfigure it in Settings. */
    panel?: { title?: string | null; side?: "left" | "right" | null; shortcut?: string | null } | null;
    /** Top-level sidebar page (app-scoped). */
    sidebar?: { title?: string | null; icon?: string | null } | null;
    /** Whether it ships an MCP server. */
    mcp?: boolean;
    /** Whether it ships a node backend (contributes.backend) for its panel. */
    backend?: boolean;
    /** Number of app-scoped IM Connect providers contributed by the plugin. */
    connectProviders?: number;
  };
}

/** List all registered plugins. */
export async function listPlugins(): Promise<Plugin[]> {
  const r = await apiClient.get<{ plugins: Plugin[] }>('/api/v1/plugins');
  return r.plugins;
}

/**
 * Delete a plugin. For local/git plugins this also removes the copied/cloned
 * files; for dev plugins it only drops the registry entry (your folder stays).
 */
export async function deletePlugin(id: string): Promise<{ ok: boolean }> {
  const result = await apiClient.delete<{ ok: boolean }>(`/api/v1/plugins/${id}`);
  notifyPluginsChanged();
  return result;
}

/** Reveal a plugin's folder in the OS file manager (Finder / Explorer). */
export async function revealPluginFolder(id: string): Promise<void> {
  return apiClient.postNoContent(`/api/v1/plugins/${id}/reveal`);
}

/** Rewrite a dev plugin's vendored SDK (`src/grove-sdk/*`) to this Grove's
 *  version. Dev plugins only; run `npm run build` afterwards. */
export async function updatePluginSdk(id: string): Promise<{ ok: boolean; files: string[] }> {
  return apiClient.post<undefined, { ok: boolean; files: string[] }>(
    `/api/v1/plugins/${id}/update-sdk`,
  );
}

/** Install an existing local plugin folder (copied into Grove's storage). */
export async function installLocalPlugin(
  path: string,
): Promise<{ ok: boolean; plugin: Plugin; warning?: string | null }> {
  const result = await apiClient.post<{ path: string }, { ok: boolean; plugin: Plugin; warning?: string | null }>(
    '/api/v1/plugins/install-local',
    { path },
  );
  notifyPluginsChanged();
  return result;
}

/** Install a plugin from a git repo (cloned into Grove's storage). */
export async function installGitPlugin(
  url: string,
  subpath?: string,
): Promise<{ ok: boolean; plugin: Plugin; warning?: string | null }> {
  const result = await apiClient.post<{ url: string; subpath?: string }, { ok: boolean; plugin: Plugin; warning?: string | null }>(
    '/api/v1/plugins/install-git',
    { url, subpath },
  );
  notifyPluginsChanged();
  return result;
}

/**
 * Install a plugin from an uploaded `.zip`. The backend extracts it, finds the
 * `plugin.json` (at the zip root or inside a single top-level folder), copies
 * the plugin into Grove's storage, and registers it as `local`. Saves the user
 * from unzipping by hand.
 */
export async function installZipPlugin(
  file: File | Blob,
): Promise<{ ok: boolean; plugin: Plugin; warning?: string | null }> {
  const form = new FormData();
  form.append('file', file);
  const result = await apiClient.postFormData<{ ok: boolean; plugin: Plugin; warning?: string | null }>(
    '/api/v1/plugins/install-zip',
    form,
  );
  notifyPluginsChanged();
  return result;
}

/**
 * Register an existing plugin folder as a `dev` plugin — referenced in place
 * (not copied), so edits hot-reload. The folder must already contain a
 * plugin.json. For starting a brand-new plugin, use the Develop flow instead.
 */
/** One of the task's chat sessions, as exposed to a plugin panel. */
export interface PluginChat {
  id: string;
  title: string;
  agent: string;
}

/**
 * List the chat sessions of the task a plugin panel is scoped to. Requires the
 * plugin's `chat:read` permission (enforced backend-side).
 */
export async function listPluginChats(
  pluginId: string,
  projectId: string,
  taskId: string,
): Promise<PluginChat[]> {
  const qs = `projectId=${encodeURIComponent(projectId)}&taskId=${encodeURIComponent(taskId)}`;
  const r = await apiClient.get<{ chats: PluginChat[] }>(
    `/api/v1/plugins/${pluginId}/chat/list?${qs}`,
  );
  return r.chats;
}

/**
 * Inject a user prompt into one of the task's chats. Requires the plugin's
 * `chat:write` permission (enforced backend-side).
 */
export async function sendPluginChat(
  pluginId: string,
  body: { projectId: string; taskId: string; chatId: string; text: string },
): Promise<{ ok: boolean }> {
  return apiClient.post<
    { projectId: string; taskId: string; chatId: string; text: string },
    { ok: boolean }
  >(`/api/v1/plugins/${pluginId}/chat/send`, body);
}

export async function registerDevPlugin(
  path: string,
): Promise<{ ok: boolean; plugin: Plugin }> {
  const result = await apiClient.post<{ path: string }, { ok: boolean; plugin: Plugin }>(
    '/api/v1/plugins',
    { path },
  );
  notifyPluginsChanged();
  return result;
}
