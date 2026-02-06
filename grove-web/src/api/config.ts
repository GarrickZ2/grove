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
  terminal_theme?: string;
}

export interface Config {
  theme: ThemeConfig;
  layout: LayoutConfig;
  web: WebConfig;
  multiplexer: string;
}

export interface ConfigPatch {
  theme?: Partial<ThemeConfig>;
  layout?: Partial<LayoutConfig>;
  web?: Partial<WebConfig>;
  multiplexer?: string;
}

// Application info for picker
export interface AppInfo {
  name: string;
  path: string;
  bundle_id?: string;
}

export interface ApplicationsResponse {
  apps: AppInfo[];
}

// API functions
export async function getConfig(): Promise<Config> {
  return apiClient.get<Config>('/api/v1/config');
}

export async function patchConfig(patch: ConfigPatch): Promise<Config> {
  return apiClient.patch<ConfigPatch, Config>('/api/v1/config', patch);
}

export async function listApplications(): Promise<AppInfo[]> {
  const response = await apiClient.get<ApplicationsResponse>('/api/v1/config/applications');
  return response.apps;
}
