// Config API

import { apiClient } from './client';

// Types
export interface ThemeConfig {
  name: string;
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
  platform: string; // "macos" | "windows" | "linux"
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
export async function getConfig(): Promise<Config> {
  return apiClient.get<Config>('/api/v1/config');
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
