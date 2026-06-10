// Config API

import { apiClient } from './client';

export interface CustomThemeConfig {
  id: string;
  name: string;
  colors: {
    bg: string;
    bg_secondary: string;
    bg_tertiary: string;
    border: string;
    text: string;
    text_muted: string;
    highlight: string;
    accent: string;
    success: string;
    warning: string;
    error: string;
    info: string;
  };
  accent_palette: string[];
  is_light: boolean;
}

// Types
export interface ThemeConfig {
  name: string;
  mode: string;
  light_theme: string;
  dark_theme: string;
  custom_themes: CustomThemeConfig[];
}

export interface LayoutConfig {
  default: string;
  agent_command?: string;
  /** JSON string of custom layouts array */
  custom_layouts?: string;
  /** Selected custom layout ID (when default="custom") */
  selected_custom_id?: string;
}

export interface WebConfig {
  ide?: string;
  terminal?: string;
  /** Web terminal backend: "multiplexer" (default) | "direct" */
  terminal_mode?: string;
  /** Workspace layout mode: "flex" (default) | "ide" */
  workspace_layout?: "flex" | "ide";
  /** GUI-only global shortcut for showing or hiding the main window. */
  show_hide_window_shortcut?: string;
}

export interface AutoLinkConfig {
  patterns: string[];
}

export interface CustomAgentServer {
  id: string;
  name: string;
  type: 'local' | 'remote';
  command?: string;
  args?: string[];
  url?: string;
  auth_header?: string;
}

export interface AcpConfig {
  agent_command?: string;
  custom_agents: CustomAgentServer[];
  /** Frontend chat view message window. 0 means Unlimited. */
  render_window_limit: number;
  /** Prune when the frontend chat view reaches this many UI messages. */
  render_window_trigger: number;
}

export interface HooksConfig {
  response_sound_enabled: boolean;
  response_sound: string;
  permission_sound_enabled: boolean;
  permission_sound: string;
}

export interface SupportedLanguage {
  id: string;
  display_name: string;
  extensions: string[];
}

export interface IndexingConfig {
  /** Master toggle for symbol indexing (cmd+click navigation). */
  enabled: boolean;
  /** Language IDs the user has opted out of (deny-list). */
  disabled_languages: string[];
  /** Read-only: full list of languages the running grove binary supports. */
  supported_languages: SupportedLanguage[];
}

export interface NotificationsConfig {
  /** Whether the menubar tray icon is enabled at all. */
  tray_enabled: boolean;
  tray_show_permission: boolean;
  tray_show_done: boolean;
  tray_show_running: boolean;
  /** Whether macOS / system notifications fire at all. */
  notification_enabled: boolean;
  notification_show_permission: boolean;
  notification_show_done: boolean;
  notification_show_running: boolean;
  /** Global shortcut to show / hide the menubar popover. Empty = disabled. */
  menubar_shortcut?: string | null;
  /** Retention policy for tray "Done" chats. Wire shape matches the Rust
   *  externally-tagged enum (see `RetentionPolicy` in storage/config.rs). */
  tray_done_retention?: RetentionPolicyWire;
}

/** Wire shape of `notifications.tray_done_retention` (externally tagged). */
export type RetentionPolicyWire =
  | { forever?: null }
  | { expire?: { value?: number; unit?: "hours" | "days" } };

export interface BrowserControlConfig {
  /** Master switch — when false the AI cannot drive the user's browser at all. */
  enabled?: boolean;
  /** Auto-organize AI-opened tabs into per-task Chrome Tab Groups. */
  auto_groups?: boolean;
}

export interface Config {
  theme: ThemeConfig;
  layout: LayoutConfig;
  web: WebConfig;
  terminal_multiplexer: string; // "tmux" | "zellij"
  auto_link: AutoLinkConfig;
  acp: AcpConfig;
  hooks: HooksConfig;
  notifications: NotificationsConfig;
  indexing: IndexingConfig;
  browser_control: BrowserControlConfig;
  platform: string; // "macos" | "windows" | "linux"
}

interface IndexingConfigPatch {
  enabled?: boolean;
  disabled_languages?: string[];
}

interface ConfigPatch {
  theme?: Partial<ThemeConfig>;
  layout?: Partial<LayoutConfig>;
  web?: Partial<WebConfig>;
  terminal_multiplexer?: string;
  auto_link?: Partial<AutoLinkConfig>;
  acp?: Partial<AcpConfig>;
  hooks?: Partial<HooksConfig>;
  notifications?: Partial<NotificationsConfig>;
  indexing?: IndexingConfigPatch;
  browser_control?: Partial<BrowserControlConfig>;
}

// Application info for picker
export interface AppInfo {
  name: string;
  path: string;
  bundle_id?: string;
}

interface ApplicationsResponse {
  apps: AppInfo[];
  platform: string;
}

// API functions
export async function getConfig(signal?: AbortSignal): Promise<Config> {
  return apiClient.get<Config>('/api/v1/config', signal);
}

export async function patchConfig(patch: ConfigPatch): Promise<Config> {
  return apiClient.patch<ConfigPatch, Config>('/api/v1/config', patch);
}

export async function listApplications(): Promise<{ apps: AppInfo[]; platform: string }> {
  return apiClient.get<ApplicationsResponse>('/api/v1/config/applications');
}

export function getAppIconUrl(app: AppInfo): string {
  return `/api/v1/config/applications/icon?path=${encodeURIComponent(app.path)}`;
}

export async function previewHookSound(sound: string): Promise<void> {
  return apiClient.post<{ sound: string }, void>('/api/v1/hooks/preview', { sound });
}
