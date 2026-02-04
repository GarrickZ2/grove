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
}

export interface Config {
  theme: ThemeConfig;
  layout: LayoutConfig;
  web: WebConfig;
}

export interface ConfigPatch {
  theme?: Partial<ThemeConfig>;
  layout?: Partial<LayoutConfig>;
  web?: Partial<WebConfig>;
}

// API functions
export async function getConfig(): Promise<Config> {
  return apiClient.get<Config>('/api/v1/config');
}

export async function patchConfig(patch: ConfigPatch): Promise<Config> {
  return apiClient.patch<ConfigPatch, Config>('/api/v1/config', patch);
}
